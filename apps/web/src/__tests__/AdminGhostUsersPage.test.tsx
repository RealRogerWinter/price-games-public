import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../api/adminClient", () => ({
  getGhostSettings: vi.fn(),
  updateGhostSettings: vi.fn(),
  listGhostUsers: vi.fn(),
  bulkCreateGhosts: vi.fn(),
  patchGhostUser: vi.fn(),
  deleteGhostUser: vi.fn(),
  triggerGhostKillSwitch: vi.fn(),
  getAutoLobbySettings: vi.fn(),
  updateAutoLobbySettings: vi.fn(),
}));

import * as adminClient from "../api/adminClient";
import AdminGhostUsersPage from "../pages/admin/AdminGhostUsersPage";

const mockGetSettings = vi.mocked(adminClient.getGhostSettings);
const mockUpdateSettings = vi.mocked(adminClient.updateGhostSettings);
const mockList = vi.mocked(adminClient.listGhostUsers);
const mockBulkCreate = vi.mocked(adminClient.bulkCreateGhosts);
const mockPatch = vi.mocked(adminClient.patchGhostUser);
const mockDelete = vi.mocked(adminClient.deleteGhostUser);
const mockKill = vi.mocked(adminClient.triggerGhostKillSwitch);
const mockGetAutoLobby = vi.mocked(adminClient.getAutoLobbySettings);
const mockUpdateAutoLobby = vi.mocked(adminClient.updateAutoLobbySettings);

const baseAutoLobby: adminClient.AutoLobbySettings = {
  enabled: false,
  targetCount: 8,
  targetMin: 4,
  disguiseRatioMin: 50,
  disguiseRatioMax: 70,
  countdownMinSeconds: 15,
  countdownMaxSeconds: 45,
  modeAllowlist: [],
};

const baseSettings: adminClient.GhostSettings = {
  enabled: false,
  killSwitch: false,
  showOnLeaderboard: false,
  percentileCap: 70,
  targetCount: 35,
};

function makeGhost(overrides: Partial<adminClient.GhostUserRow> = {}): adminClient.GhostUserRow {
  return {
    id: "g1",
    username: "alice42",
    username_normalized: "alice42",
    avatar: "silhouette",
    lifetime_score: 0,
    account_created_at: "2026-01-01T00:00:00Z",
    on_shift: 0,
    shift_started_at: null,
    shift_ends_at: null,
    on_break_until: null,
    is_active: 1,
    last_played_at: null,
    daily_streak_current: 0,
    daily_streak_best: 0,
    daily_streak_last_date: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockResolvedValue({ settings: baseSettings });
  mockList.mockResolvedValue({ ghosts: [] });
  mockGetAutoLobby.mockResolvedValue({ settings: baseAutoLobby });
});

describe("AdminGhostUsersPage", () => {
  it("renders loading state initially", () => {
    mockGetSettings.mockReturnValue(new Promise(() => {}));
    mockList.mockReturnValue(new Promise(() => {}));
    render(<AdminGhostUsersPage />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders the auto-lobby toggle and reflects current state", async () => {
    mockGetAutoLobby.mockResolvedValue({
      settings: { ...baseAutoLobby, enabled: true, targetMin: 4, targetCount: 8 },
    });
    render(<AdminGhostUsersPage />);
    await waitFor(() => {
      const checkbox = screen.getByRole("checkbox", { name: /Auto-lobbies enabled/i });
      expect(checkbox).toBeChecked();
    });
    expect((screen.getByLabelText(/Min lobbies/i) as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText(/Max lobbies/i) as HTMLInputElement).value).toBe("8");
  });

  it("calls updateAutoLobbySettings when the auto-lobby toggle is flipped", async () => {
    mockUpdateAutoLobby.mockResolvedValue({
      settings: { ...baseAutoLobby, enabled: true },
    });
    render(<AdminGhostUsersPage />);
    await waitFor(() => screen.getByRole("checkbox", { name: /Auto-lobbies enabled/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Auto-lobbies enabled/i }));
    await waitFor(() => {
      expect(mockUpdateAutoLobby).toHaveBeenCalledWith({ enabled: true });
    });
  });

  it("disables the band inputs when auto-lobbies is off", async () => {
    render(<AdminGhostUsersPage />);
    await waitFor(() => screen.getByRole("checkbox", { name: /Auto-lobbies enabled/i }));
    expect(screen.getByLabelText(/Min lobbies/i)).toBeDisabled();
    expect(screen.getByLabelText(/Max lobbies/i)).toBeDisabled();
  });

  it("renders the master toggle and reflects enabled state", async () => {
    mockGetSettings.mockResolvedValue({ settings: { ...baseSettings, enabled: true } });
    render(<AdminGhostUsersPage />);
    await waitFor(() => {
      const checkbox = screen.getByRole("checkbox", { name: /Enabled — master toggle/i });
      expect(checkbox).toBeChecked();
    });
  });

  it("calls updateGhostSettings when the master toggle is flipped", async () => {
    mockUpdateSettings.mockResolvedValue({ settings: { ...baseSettings, enabled: true } });
    render(<AdminGhostUsersPage />);
    const toggle = await screen.findByRole("checkbox", { name: /Enabled — master toggle/i });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({ enabled: true });
    });
  });

  it("shows the kill-switch button when not active", async () => {
    render(<AdminGhostUsersPage />);
    await screen.findByText(/Trigger kill-switch/i);
  });

  it("replaces the kill-switch with a Clear button when active", async () => {
    mockGetSettings.mockResolvedValue({ settings: { ...baseSettings, killSwitch: true } });
    render(<AdminGhostUsersPage />);
    await screen.findByText(/Kill-switch is ACTIVE/i);
    expect(screen.getByRole("button", { name: /Clear kill-switch/i })).toBeInTheDocument();
  });

  it("calls bulkCreateGhosts with the chosen count", async () => {
    mockBulkCreate.mockResolvedValue({ created: 10, ghosts: [] });
    render(<AdminGhostUsersPage />);
    const countInput = await screen.findByLabelText(/Bulk-create N ghosts/i);
    fireEvent.change(countInput, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    await waitFor(() => {
      expect(mockBulkCreate).toHaveBeenCalledWith(10);
    });
  });

  it("renders roster rows with status text derived from ghost flags", async () => {
    mockList.mockResolvedValue({
      ghosts: [
        makeGhost({ id: "active-idle", username: "alice", is_active: 1, on_shift: 0 }),
        makeGhost({ id: "active-onshift", username: "bob", is_active: 1, on_shift: 1 }),
        makeGhost({ id: "retired", username: "carol", is_active: 0 }),
      ],
    });
    render(<AdminGhostUsersPage />);
    await screen.findByText("alice");
    expect(screen.getAllByText("idle").length).toBeGreaterThan(0);
    expect(screen.getAllByText("on shift").length).toBeGreaterThan(0);
    expect(screen.getAllByText("retired").length).toBeGreaterThan(0);
  });

  it("triggers kill-switch via API when button is confirmed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockKill.mockResolvedValue({ killSwitchActive: true, evictedShifts: 3 });
    // Initial settings have killSwitch=false so the trigger button is rendered
    // (otherwise the page would render the "Clear kill-switch" button instead).
    mockGetSettings.mockResolvedValue({ settings: { ...baseSettings, killSwitch: false } });
    render(<AdminGhostUsersPage />);
    const trigger = await screen.findByRole("button", { name: /Trigger kill-switch/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(mockKill).toHaveBeenCalled();
    });
    confirmSpy.mockRestore();
  });

  it("calls patchGhostUser when Deactivate is clicked", async () => {
    mockList.mockResolvedValue({
      ghosts: [makeGhost({ id: "g1", username: "alice", is_active: 1 })],
    });
    mockPatch.mockResolvedValue({ ghost: null });
    render(<AdminGhostUsersPage />);
    const button = await screen.findByRole("button", { name: /Deactivate/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith("g1", { isActive: false });
    });
  });

  it("calls deleteGhostUser when Delete is confirmed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockList.mockResolvedValue({
      ghosts: [makeGhost({ id: "g1", username: "alice" })],
    });
    mockDelete.mockResolvedValue({ deleted: true, id: "g1" });
    render(<AdminGhostUsersPage />);
    const button = await screen.findByRole("button", { name: /^Delete$/ });
    fireEvent.click(button);
    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("g1");
    });
    confirmSpy.mockRestore();
  });
});
