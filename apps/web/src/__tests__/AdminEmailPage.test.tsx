/**
 * Tests for AdminEmailPage — the five-tab admin email management page.
 *
 * We mock the adminClient module rather than the raw fetch so the test
 * focuses on UI behavior (tab switching, form interactions, dispatch of
 * the right API calls). Server behavior is covered by adminEmail.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../api/adminClient", () => ({
  fetchEmailTemplates: vi.fn(),
  createEmailTemplate: vi.fn(),
  updateEmailTemplate: vi.fn(),
  deleteEmailTemplate: vi.fn(),
  sendAdminEmail: vi.fn(),
  sendTestAdminEmail: vi.fn(),
  fetchEmailStats: vi.fn(),
  fetchEmailLog: vi.fn(),
  fetchEmailTriggers: vi.fn(),
  updateEmailTrigger: vi.fn(),
}));

import * as adminClient from "../api/adminClient";
import AdminEmailPage from "../pages/admin/AdminEmailPage";

const mockFetchStats = vi.mocked(adminClient.fetchEmailStats);
const mockFetchTemplates = vi.mocked(adminClient.fetchEmailTemplates);
const mockCreateTemplate = vi.mocked(adminClient.createEmailTemplate);
const mockFetchTriggers = vi.mocked(adminClient.fetchEmailTriggers);
const mockUpdateTrigger = vi.mocked(adminClient.updateEmailTrigger);
const mockFetchLog = vi.mocked(adminClient.fetchEmailLog);

const emptyStats = {
  totalSent: 0,
  totalDelivered: 0,
  totalOpened: 0,
  totalClicked: 0,
  totalBounced: 0,
  totalComplained: 0,
  openRate: 0,
  clickRate: 0,
  bounceRate: 0,
  byType: [],
};

describe("AdminEmailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchStats.mockResolvedValue(emptyStats);
    mockFetchTemplates.mockResolvedValue({ templates: [] });
    mockFetchTriggers.mockResolvedValue({ triggers: [] });
    mockFetchLog.mockResolvedValue({ entries: [], total: 0, page: 1, totalPages: 0 });
  });

  it("renders the page header and tabs", async () => {
    render(<AdminEmailPage />);
    expect(screen.getByTestId("admin-email-page")).toBeInTheDocument();
    expect(screen.getByTestId("admin-email-tab-stats")).toBeInTheDocument();
    expect(screen.getByTestId("admin-email-tab-send")).toBeInTheDocument();
    expect(screen.getByTestId("admin-email-tab-templates")).toBeInTheDocument();
    expect(screen.getByTestId("admin-email-tab-triggers")).toBeInTheDocument();
    expect(screen.getByTestId("admin-email-tab-log")).toBeInTheDocument();
    await waitFor(() => expect(mockFetchStats).toHaveBeenCalled());
  });

  it("shows stats values rendered from the fetch response", async () => {
    mockFetchStats.mockResolvedValueOnce({
      ...emptyStats,
      totalSent: 17,
      openRate: 42.5,
      clickRate: 11.1,
      bounceRate: 0.3,
    });
    render(<AdminEmailPage />);
    await waitFor(() => expect(screen.getByText("17")).toBeInTheDocument());
    expect(screen.getByText("42.5%")).toBeInTheDocument();
    expect(screen.getByText("11.1%")).toBeInTheDocument();
  });

  it("switches to templates tab and loads templates", async () => {
    mockFetchTemplates.mockResolvedValueOnce({
      templates: [
        {
          id: 1,
          name: "streak",
          type: "streak_risk",
          subjectTemplate: "hi",
          htmlTemplate: "<p>h</p>",
          textTemplate: null,
          isActive: true,
          createdAt: "2026-04-17",
          updatedAt: "2026-04-17",
        },
      ],
    });
    render(<AdminEmailPage />);
    fireEvent.click(screen.getByTestId("admin-email-tab-templates"));
    await waitFor(() => expect(screen.getByText("streak")).toBeInTheDocument());
  });

  it("creates a new template via the form", async () => {
    mockFetchTemplates.mockResolvedValue({ templates: [] });
    mockCreateTemplate.mockResolvedValue({
      id: 1,
      name: "new",
      type: "promotional",
      subjectTemplate: "s",
      htmlTemplate: "h",
      textTemplate: null,
      isActive: true,
      createdAt: "2026-04-17",
      updatedAt: "2026-04-17",
    });
    const { container } = render(<AdminEmailPage />);
    fireEvent.click(screen.getByTestId("admin-email-tab-templates"));

    await waitFor(() => expect(screen.getByText(/No templates yet/)).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ New Template"));

    // Labels in the form aren't associated via htmlFor (intentional: the
    // form uses implicit association via markup position). Query inputs
    // by type/order to avoid the role-based matcher needing a label.
    const textInputs = container.querySelectorAll('input[type="text"], input:not([type])');
    fireEvent.change(textInputs[0]!, { target: { value: "new" } });
    fireEvent.change(textInputs[1]!, { target: { value: "s" } });
    const textareas = container.querySelectorAll("textarea");
    fireEvent.change(textareas[0]!, { target: { value: "h" } });

    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalled());
  });

  it("switches to triggers tab and renders trigger cards", async () => {
    mockFetchTriggers.mockResolvedValueOnce({
      triggers: [
        {
          type: "streak_risk",
          isEnabled: false,
          cooldownHours: 72,
          thresholdJson: '{"streakMin":3}',
          templateId: null,
          updatedAt: "2026-04-17",
        },
      ],
    });
    render(<AdminEmailPage />);
    fireEvent.click(screen.getByTestId("admin-email-tab-triggers"));
    await waitFor(() =>
      expect(screen.getByTestId("email-trigger-toggle-streak_risk")).toBeInTheDocument(),
    );
  });

  it("flips a trigger via the toggle", async () => {
    mockFetchTriggers.mockResolvedValueOnce({
      triggers: [
        {
          type: "streak_risk",
          isEnabled: false,
          cooldownHours: 72,
          thresholdJson: null,
          templateId: null,
          updatedAt: "2026-04-17",
        },
      ],
    });
    mockUpdateTrigger.mockResolvedValue({
      type: "streak_risk",
      isEnabled: true,
      cooldownHours: 72,
      thresholdJson: null,
      templateId: null,
      updatedAt: "2026-04-17",
    });
    // Second fetch-triggers returns the updated list
    mockFetchTriggers.mockResolvedValue({
      triggers: [
        {
          type: "streak_risk",
          isEnabled: true,
          cooldownHours: 72,
          thresholdJson: null,
          templateId: null,
          updatedAt: "2026-04-17",
        },
      ],
    });

    render(<AdminEmailPage />);
    fireEvent.click(screen.getByTestId("admin-email-tab-triggers"));
    await waitFor(() =>
      expect(screen.getByTestId("email-trigger-toggle-streak_risk")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("email-trigger-toggle-streak_risk"));
    await waitFor(() =>
      expect(mockUpdateTrigger).toHaveBeenCalledWith("streak_risk", { isEnabled: true }),
    );
  });

  it("switches to log tab and queries with default filters", async () => {
    render(<AdminEmailPage />);
    fireEvent.click(screen.getByTestId("admin-email-tab-log"));
    await waitFor(() => expect(mockFetchLog).toHaveBeenCalled());
  });
});
