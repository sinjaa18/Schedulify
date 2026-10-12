import { test, expect } from "@playwright/test";

const password = process.env.E2E_TEST_PASSWORD;

async function login(page, email) {
  await page.goto("/");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  const initialData = /^(administrator|hod)[.@]/i.test(email)
    ? page.waitForResponse((response) => new URL(response.url()).pathname === "/api/domain" && response.request().method() === "GET")
    : null;
  const loginResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/login" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
  if (initialData) await initialData;
  return loginResponse.then((response) => response.json());
}

async function logout(page) {
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page.getByPlaceholder("Email")).toBeVisible();
}

async function addResource(page, inputLabel, buttonLabel, value) {
  await page.getByRole("textbox", { name: inputLabel }).fill(value);
  await page.getByRole("button", { name: buttonLabel, exact: true }).click();
}

async function setDatabaseUnavailable(unavailable) {
  const response = await fetch(`${process.env.E2E_CONTROL_URL}/database-state`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unavailable }),
  });
  expect(response.status).toBe(204);
}

test("Admin configures and generates, HOD approves, and teacher/student views stay scoped", async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  await login(page, "administrator@e2e.test");
  await page.getByRole("button", { name: "Admin", exact: true }).click();

  await addResource(page, "Subject name", "Add subject", "E2E Mathematics");
  await addResource(page, "Subject name", "Add subject", "E2E Physics");
  await addResource(page, "Teacher name", "Add teacher", "E2E Teacher One");
  await addResource(page, "Teacher name", "Add teacher", "E2E Teacher Two");
  await addResource(page, "Room name", "Add room", "E2E Room One");
  await addResource(page, "Room name", "Add room", "E2E Room Two");
  await addResource(page, "Batch name", "Add batch", "E2E Batch One");
  await addResource(page, "Batch name", "Add batch", "E2E Batch Two");

  for (const [teacher, subject] of [["E2E Teacher One", "E2E Mathematics"], ["E2E Teacher Two", "E2E Physics"]]) {
    const card = page.locator("details").filter({ hasText: teacher });
    await card.locator("summary").first().click();
    await card.getByRole("checkbox", { name: subject, exact: true }).check();
  }
  for (const [batch, subject] of [["E2E Batch One", "E2E Mathematics"], ["E2E Batch Two", "E2E Physics"]]) {
    const batchCard = page.locator("section").filter({ has: page.getByLabel(`${batch} subject`) }).last();
    const subjectChoice = page.getByLabel(`${batch} subject`);
    await subjectChoice.selectOption({ label: subject });
    await expect(subjectChoice).toHaveValue(/.+/);
    await page.getByLabel(`${batch} weekly sessions`).fill("1");
    await batchCard.getByRole("button", { name: "Add weekly requirement" }).click();
    await expect(batchCard.getByText(`${subject} · 1/week`)).toBeVisible();
  }
  await page.getByRole("button", { name: "Save scheduling data" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Scheduling data saved to the server." })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Admin", exact: true }).click();

  await expect(page.getByLabel("Teacher record for teacher.one@e2e.test").locator("option", { hasText: "E2E Teacher One" })).toBeAttached();
  await page.getByLabel("Teacher record for teacher.one@e2e.test").selectOption({ label: "E2E Teacher One" });
  await page.getByLabel("Teacher record for teacher.two@e2e.test").selectOption({ label: "E2E Teacher Two" });
  await page.getByLabel("Student batch for student.one@e2e.test").selectOption({ label: "E2E Batch One" });
  await page.getByLabel("Student batch for student.two@e2e.test").selectOption({ label: "E2E Batch Two" });
  await expect(page.getByRole("status").filter({ hasText: "Account linked to its scheduling record." }).last()).toBeVisible();

  await page.getByRole("button", { name: "AI Copilot", exact: true }).click();
  await page.getByLabel("What should the timetable account for?").fill("Keep Friday afternoon free.");
  await page.getByRole("button", { name: "Interpret request" }).click();
  await expect(page.getByText("Keep Friday afternoons free for all batches.")).toBeVisible();
  await page.getByRole("button", { name: "Confirm requirements" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Requirements confirmed" })).toBeVisible();

  await page.getByLabel("What should the timetable account for?").fill("Malformed response fixture");
  await page.getByRole("button", { name: "Interpret request" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "malformed structured data" })).toBeVisible();

  await page.getByLabel("What should the timetable account for?").fill("Missing config fixture");
  await page.getByRole("button", { name: "Interpret request" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "AI is not configured" })).toBeVisible();

  await page.getByRole("button", { name: "Admin", exact: true }).click();
  const generatedResponse = page.waitForResponse((response) => response.url().includes("/api/timetables/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate candidate" }).click();
  const generation = await (await generatedResponse).json();
  expect(generation.ok, JSON.stringify(generation)).toBe(true);
  expect(generation.version?.id).toBeTruthy();
  expect(generation.validation?.valid).toBe(true);
  expect(generation.timetable).toHaveLength(2);
  expect(generation.timetable.every((row) => !(row.day === "Fri" && ["2-3", "3-4"].includes(row.slot)))).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Validated candidate stored on the server." })).toBeVisible();

  // Change the canonical data after generation. The old candidate must become stale.
  await page.getByLabel("E2E Batch One name").fill("E2E Batch One Revised");
  await page.getByRole("button", { name: "Save scheduling data" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Scheduling data saved to the server." })).toBeVisible();
  await logout(page);
  const hodSession = await login(page, "hod.reviewer@e2e.test");
  await page.getByRole("button", { name: "HOD", exact: true }).click();
  const staleAttempt = await page.evaluate(async ({ versionId, csrfToken }) => {
    const response = await fetch(`/api/timetables/${versionId}/approve`, { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": csrfToken } });
    return { status: response.status, body: await response.json() };
  }, { versionId: generation.version.id, csrfToken: hodSession.csrfToken });
  expect(staleAttempt.status).toBe(409);
  expect(staleAttempt.body.code).toBe("invalid_transition");
  expect(staleAttempt.body.status).toBe("stale");

  await logout(page);
  await login(page, "administrator@e2e.test");
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await page.getByRole("button", { name: "Generate candidate" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Validated candidate stored on the server." })).toBeVisible();
  await logout(page);
  await login(page, "hod.reviewer@e2e.test");
  await page.getByRole("button", { name: "HOD", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^candidate · revision/ }).first()).toBeVisible();
  await expect(page.getByText("Independent validation: passed")).toBeVisible();
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Candidate rejected." })).toBeVisible();

  await logout(page);
  await login(page, "administrator@e2e.test");
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await page.getByRole("button", { name: "Generate candidate" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Validated candidate stored on the server." })).toBeVisible();
  await logout(page);
  await login(page, "hod.reviewer@e2e.test");
  await page.getByRole("button", { name: "HOD", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^candidate · revision/ }).first()).toBeVisible();
  await expect(page.getByText(/^rejected · revision \d+/).first()).toBeVisible();
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Timetable published." })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^approved · revision/ }).first()).toBeVisible();

  await logout(page);
  await login(page, "teacher.one@e2e.test");
  await page.getByRole("button", { name: "Timetable", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My Teacher Timetable" })).toBeVisible();
  await expect(page.getByText("E2E Mathematics")).toBeVisible();
  await expect(page.getByText("E2E Physics")).toHaveCount(0);
  const teacherScope = await page.evaluate(async () => fetch("/api/timetable/mine?teacherId=another-account&batchId=E2E%20Batch%20Two", { credentials: "same-origin" }).then((response) => response.json()));
  expect(teacherScope.timetable).toHaveLength(1);
  expect(teacherScope.timetable[0].subject).toBe("E2E Mathematics");

  await logout(page);
  await login(page, "student.two@e2e.test");
  await page.getByRole("button", { name: "Timetable", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My Student Timetable" })).toBeVisible();
  await expect(page.getByText("E2E Physics")).toBeVisible();
  await expect(page.getByText("E2E Mathematics")).toHaveCount(0);
  const studentScope = await page.evaluate(async () => fetch("/api/timetable/mine?batchId=E2E%20Batch%20One&userId=another-account", { credentials: "same-origin" }).then((response) => response.json()));
  expect(studentScope.timetable).toHaveLength(1);
  expect(studentScope.timetable[0].subject).toBe("E2E Physics");

  await setDatabaseUnavailable(true);
  const databaseFailure = await page.evaluate(async () => {
    const response = await fetch("/api/timetable/mine", { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  });
  expect(databaseFailure).toEqual({ status: 503, body: { error: "Authentication service is temporarily unavailable." } });
  const readinessFailure = await page.evaluate(async () => {
    const response = await fetch("/api/health/ready");
    return { status: response.status, body: await response.json() };
  });
  expect(readinessFailure).toEqual({ status: 503, body: { ok: false, checks: { postgres: "unavailable" } } });
  await page.reload();
  await expect(page.getByPlaceholder("Email")).toBeVisible();
  await expect(page.getByText("The authentication API is unavailable. Start the API and refresh.")).toBeVisible();

  await setDatabaseUnavailable(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
  await page.getByRole("button", { name: "Timetable", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My Student Timetable" })).toBeVisible();

  await logout(page);
  const revokedSessionResponse = await page.evaluate(() => fetch("/api/timetable/mine", { credentials: "same-origin" }).then((response) => response.status));
  expect(revokedSessionResponse).toBe(401);
});

test("the sign-in page reports an unavailable API and recovers after refresh", async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByPlaceholder("Email")).toBeVisible();
  await expect(page.getByText("The authentication API is unavailable. Start the API and refresh.")).toBeVisible();
  await page.unroute("**/api/auth/session");
  await page.reload();
  await expect(page.getByPlaceholder("Email")).toBeVisible();
  await expect(page.getByText("The authentication API is unavailable. Start the API and refresh.")).toHaveCount(0);
});

test("an infeasible generation is shown as a failure and is never presented as a candidate", async ({ page }) => {
  const loginData = await login(page, "administrator@e2e.test");
  const session = await page.evaluate(() => fetch("/api/domain", { credentials: "same-origin" }).then((response) => response.json()));
  const csrfToken = loginData?.csrfToken;
  expect(session.domain.teachers.length).toBeGreaterThan(0);
  expect(csrfToken).toBeTruthy();
  const failedSave = await page.evaluate(async ({ domain, revision, csrfToken }) => fetch("/api/domain", {
    method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify({ expectedRevision: revision, domain: { ...domain, teachers: domain.teachers.map((teacher) => ({ ...teacher, subjectIds: [] })) } }),
  }).then(async (response) => ({ status: response.status, body: await response.json() })), { domain: session.domain, revision: session.revision, csrfToken });
  expect(failedSave.status).toBe(200);
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await page.getByRole("button", { name: "Generate candidate" }).click();
  await expect(page.getByRole("status").filter({ hasText: /infeasible/ })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Validated candidate stored on the server." })).toHaveCount(0);
});
