/**
 * Tests for the admin email client (fetchEmailTemplates, triggers, send, etc.)
 * Uses the same fetch-spy pattern as adminClient.test.ts so we only verify
 * the URL + method + body shape, not the server response handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchEmailTemplates,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  sendAdminEmail,
  sendTestAdminEmail,
  fetchEmailStats,
  fetchEmailLog,
  fetchEmailTriggers,
  updateEmailTrigger,
  fetchUserEmailPreferences,
  updateUserEmailPreferences,
} from "../api/adminClient";

describe("Admin email client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetch(data: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  it("fetchEmailTemplates GETs /templates", async () => {
    mockFetch({ templates: [] });
    await fetchEmailTemplates();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/templates",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("createEmailTemplate POSTs with body", async () => {
    mockFetch({ id: 1, name: "x" });
    await createEmailTemplate({
      name: "x",
      type: "promotional",
      subjectTemplate: "s",
      htmlTemplate: "h",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/templates",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.name).toBe("x");
  });

  it("updateEmailTemplate PUTs /templates/:id", async () => {
    mockFetch({ id: 1 });
    await updateEmailTemplate(1, { isActive: false });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/templates/1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("deleteEmailTemplate DELETEs", async () => {
    mockFetch({ ok: true });
    await deleteEmailTemplate(42);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/templates/42",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sendAdminEmail POSTs /send", async () => {
    mockFetch({ ok: true, sent: 1 });
    await sendAdminEmail({
      subject: "Hi",
      html: "<p>Hi</p>",
      type: "promotional",
      userId: "u1",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/send",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sendTestAdminEmail POSTs /send-test", async () => {
    mockFetch({ ok: true });
    await sendTestAdminEmail({ to: "test@x.com" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/send-test",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fetchEmailStats appends ?days", async () => {
    mockFetch({ totalSent: 0 });
    await fetchEmailStats(30);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/stats?days=30",
      expect.anything(),
    );
  });

  it("fetchEmailLog serializes filters into the query", async () => {
    mockFetch({ entries: [], total: 0, page: 1, totalPages: 0 });
    await fetchEmailLog({ type: "promotional", status: "sent", page: 2 });
    const urlArg = fetchSpy.mock.calls[0][0] as string;
    expect(urlArg).toContain("type=promotional");
    expect(urlArg).toContain("status=sent");
    expect(urlArg).toContain("page=2");
  });

  it("fetchEmailTriggers GETs /triggers", async () => {
    mockFetch({ triggers: [] });
    await fetchEmailTriggers();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/triggers",
      expect.anything(),
    );
  });

  it("updateEmailTrigger PUTs /triggers/:type", async () => {
    mockFetch({ type: "streak_risk", isEnabled: true });
    await updateEmailTrigger("streak_risk", { isEnabled: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/triggers/streak_risk",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("fetchUserEmailPreferences GETs per-user prefs", async () => {
    mockFetch({ emailEnabled: false });
    await fetchUserEmailPreferences("u1");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/preferences/u1",
      expect.anything(),
    );
  });

  it("updateUserEmailPreferences PUTs per-user prefs", async () => {
    mockFetch({ emailEnabled: true });
    await updateUserEmailPreferences("u1", { emailEnabled: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/email/preferences/u1",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});
