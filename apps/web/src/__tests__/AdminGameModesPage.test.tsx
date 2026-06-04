import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../context/AdminAuthContext", () => ({
  useAdminAuth: vi.fn(),
}));

vi.mock("../api/adminClient", () => ({
  getGameModeSettings: vi.fn(),
  updateGameModeSettings: vi.fn(),
}));

import { useAdminAuth } from "../context/AdminAuthContext";
import * as adminClient from "../api/adminClient";
import AdminGameModesPage from "../pages/admin/AdminGameModesPage";

const mockUseAdminAuth = vi.mocked(useAdminAuth);
const mockGetGameModeSettings = vi.mocked(adminClient.getGameModeSettings);
const mockUpdateGameModeSettings = vi.mocked(adminClient.updateGameModeSettings);

const mockModes = [
  { mode: "classic", name: "Precision", description: "Guess the exact price" },
  { mode: "higher-lower", name: "Higher or Lower", description: "Is the real price higher or lower?" },
  { mode: "comparison", name: "Comparison", description: "Which product costs more?" },
];

describe("AdminGameModesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAdminAuth.mockReturnValue({
      user: { id: "1", username: "admin", createdAt: "", updatedAt: "", lastLoginAt: null, isActive: true },
      isAuthenticated: true,
      loading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
    });
  });

  it("renders loading state initially", () => {
    mockGetGameModeSettings.mockReturnValue(new Promise(() => {}));
    render(<AdminGameModesPage />);
    expect(screen.getByText("Loading game mode settings...")).toBeInTheDocument();
  });

  it("renders game mode cards after loading", async () => {
    mockGetGameModeSettings.mockResolvedValue({ modes: mockModes, disabledModes: [] });
    render(<AdminGameModesPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-game-modes-page")).toBeInTheDocument();
    });

    expect(screen.getByText("Precision")).toBeInTheDocument();
    expect(screen.getByText("Higher or Lower")).toBeInTheDocument();
    expect(screen.getByText("Comparison")).toBeInTheDocument();
  });

  it("shows disabled modes as unchecked", async () => {
    mockGetGameModeSettings.mockResolvedValue({ modes: mockModes, disabledModes: ["higher-lower"] });
    render(<AdminGameModesPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-game-modes-page")).toBeInTheDocument();
    });

    const hlCard = screen.getByTestId("game-mode-card-higher-lower");
    expect(hlCard.className).toContain("game-mode-disabled");

    const classicCard = screen.getByTestId("game-mode-card-classic");
    expect(classicCard.className).toContain("game-mode-enabled");
  });

  it("toggles a mode on click", async () => {
    mockGetGameModeSettings.mockResolvedValue({ modes: mockModes, disabledModes: [] });
    render(<AdminGameModesPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-game-modes-page")).toBeInTheDocument();
    });

    // All modes should be enabled initially
    const classicCard = screen.getByTestId("game-mode-card-classic");
    expect(classicCard.className).toContain("game-mode-enabled");

    // Click the toggle to disable classic
    const toggle = screen.getByTestId("game-mode-toggle-classic").querySelector("input")!;
    fireEvent.click(toggle);

    // Card should now be disabled
    expect(classicCard.className).toContain("game-mode-disabled");
  });

  it("saves settings on button click", async () => {
    mockGetGameModeSettings.mockResolvedValue({ modes: mockModes, disabledModes: [] });
    mockUpdateGameModeSettings.mockResolvedValue({ modes: mockModes, disabledModes: ["classic"] });
    render(<AdminGameModesPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-game-modes-page")).toBeInTheDocument();
    });

    // Disable classic
    const toggle = screen.getByTestId("game-mode-toggle-classic").querySelector("input")!;
    fireEvent.click(toggle);

    // Save
    fireEvent.click(screen.getByTestId("game-modes-save"));

    await waitFor(() => {
      expect(mockUpdateGameModeSettings).toHaveBeenCalledWith(["classic"]);
    });

    expect(screen.getByText("Game mode settings saved")).toBeInTheDocument();
  });

  it("shows error on save failure", async () => {
    mockGetGameModeSettings.mockResolvedValue({ modes: mockModes, disabledModes: [] });
    mockUpdateGameModeSettings.mockRejectedValue(new Error("Save failed"));
    render(<AdminGameModesPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-game-modes-page")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("game-modes-save"));

    await waitFor(() => {
      expect(screen.getByText("Save failed")).toBeInTheDocument();
    });
  });

  it("shows error on load failure", async () => {
    mockGetGameModeSettings.mockRejectedValue(new Error("Load failed"));
    render(<AdminGameModesPage />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load game mode settings")).toBeInTheDocument();
    });
  });
});
