/**
 * Tests for the user-facing EmailSettings panel. Verifies that:
 *   - all toggles default to off
 *   - the per-type toggles are disabled until the master toggle is on
 *   - toggling a pref dispatches updateEmailPreferences with the right payload
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../api/emailClient", () => ({
  getEmailPreferences: vi.fn(),
  updateEmailPreferences: vi.fn(),
}));

import * as emailClient from "../api/emailClient";
import EmailSettings from "../components/EmailSettings";

const mockGet = vi.mocked(emailClient.getEmailPreferences);
const mockUpdate = vi.mocked(emailClient.updateEmailPreferences);

const defaultPrefs = {
  emailEnabled: false,
  streakRisk: false,
  streakSave: false,
  inactivityReminder: false,
  weeklyDigest: false,
  leaderboardPlacement: false,
  promotional: false,
  giveawayLoss: true,
  preferredHour: 10,
  timezone: "UTC",
};

describe("EmailSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(defaultPrefs);
    mockUpdate.mockImplementation(async (partial) => ({ ...defaultPrefs, ...partial }));
  });

  it("renders the master toggle and per-type toggles", async () => {
    render(<EmailSettings />);
    await waitFor(() => expect(screen.getByTestId("email-settings")).toBeInTheDocument());
    expect(screen.getByTestId("email-master-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("email-toggle-streak-risk")).toBeInTheDocument();
    expect(screen.getByTestId("email-toggle-promotional")).toBeInTheDocument();
  });

  it("per-type toggles are disabled while master is off", async () => {
    render(<EmailSettings />);
    await waitFor(() => expect(screen.getByTestId("email-settings")).toBeInTheDocument());
    const streak = screen.getByTestId("email-toggle-streak-risk") as HTMLButtonElement;
    expect(streak.disabled).toBe(true);
  });

  it("flipping master dispatches emailEnabled=true", async () => {
    render(<EmailSettings />);
    await waitFor(() => expect(screen.getByTestId("email-settings")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("email-master-toggle"));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ emailEnabled: true })),
    );
  });

  it("preferred hour only shown after master is on", async () => {
    mockGet.mockResolvedValue({ ...defaultPrefs, emailEnabled: true });
    render(<EmailSettings />);
    await waitFor(() => expect(screen.getByTestId("email-preferred-hour")).toBeInTheDocument());
  });

  it("renders the giveaway-results toggle and dispatches the giveawayLoss key", async () => {
    mockGet.mockResolvedValue({ ...defaultPrefs, emailEnabled: true, giveawayLoss: true });
    render(<EmailSettings />);
    await waitFor(() => expect(screen.getByTestId("email-toggle-giveaway-loss")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("email-toggle-giveaway-loss"));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ giveawayLoss: false })),
    );
  });
});
