import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../context/AdminAuthContext", () => ({
  useAdminAuth: vi.fn(),
}));

vi.mock("../api/adminClient", () => ({
  getAvatarSettings: vi.fn(),
  updateAvatarSettings: vi.fn(),
}));

vi.mock("../components/multiplayer/AvatarIcon", () => ({
  default: ({ avatar }: { avatar: string }) => <span data-testid={`avatar-icon-${avatar}`}>{avatar}</span>,
}));

import { useAdminAuth } from "../context/AdminAuthContext";
import * as adminClient from "../api/adminClient";
import AdminAvatarsPage from "../pages/admin/AdminAvatarsPage";

const mockUseAdminAuth = vi.mocked(useAdminAuth);
const mockGetAvatarSettings = vi.mocked(adminClient.getAvatarSettings);
const mockUpdateAvatarSettings = vi.mocked(adminClient.updateAvatarSettings);

const mockSettings: adminClient.AvatarSettings = {
  avatars: ["wizard", "pirate", "yeti", "moon", "sun"],
  labels: {
    wizard: "Wizard",
    pirate: "Pirate Captain",
    yeti: "Cozy Yeti",
    moon: "Sleepy Moon",
    sun: "Cool Sun",
  },
  disabledAvatars: ["pirate"],
  userCounts: { wizard: 5, pirate: 2, yeti: 0, moon: 1, sun: 0 },
};

describe("AdminAvatarsPage", () => {
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
    mockGetAvatarSettings.mockReturnValue(new Promise(() => {}));
    render(<AdminAvatarsPage />);
    expect(screen.getByText("Loading avatar settings...")).toBeInTheDocument();
  });

  it("renders avatar cards after loading", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    expect(screen.getByText("Wizard")).toBeInTheDocument();
    expect(screen.getByText("Pirate Captain")).toBeInTheDocument();
    expect(screen.getByText("Cozy Yeti")).toBeInTheDocument();
  });

  it("shows disabled avatars as dimmed with unchecked toggle", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    const pirateCard = screen.getByTestId("avatar-card-pirate");
    expect(pirateCard.className).toContain("avatar-disabled");

    const wizardCard = screen.getByTestId("avatar-card-wizard");
    expect(wizardCard.className).not.toContain("avatar-disabled");
  });

  it("toggles an avatar on click", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    const wizardCard = screen.getByTestId("avatar-card-wizard");
    expect(wizardCard.className).not.toContain("avatar-disabled");

    // Click the toggle to disable wizard
    const toggle = screen.getByTestId("avatar-toggle-wizard").querySelector("input")!;
    fireEvent.click(toggle);

    expect(wizardCard.className).toContain("avatar-disabled");
  });

  it("saves settings on button click", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    mockUpdateAvatarSettings.mockResolvedValue({
      ...mockSettings,
      disabledAvatars: ["pirate", "wizard"],
    });
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    // Disable wizard
    const toggle = screen.getByTestId("avatar-toggle-wizard").querySelector("input")!;
    fireEvent.click(toggle);

    // Save
    fireEvent.click(screen.getByTestId("avatars-save"));

    await waitFor(() => {
      expect(mockUpdateAvatarSettings).toHaveBeenCalled();
    });

    // Verify the disabled list was sent (order may vary due to Set)
    const sentDisabled = mockUpdateAvatarSettings.mock.calls[0][0];
    expect(sentDisabled).toContain("pirate");
    expect(sentDisabled).toContain("wizard");

    expect(screen.getByText("Avatar settings saved")).toBeInTheDocument();
  });

  it("shows error on save failure", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    mockUpdateAvatarSettings.mockRejectedValue(new Error("Save failed"));
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("avatars-save"));

    await waitFor(() => {
      expect(screen.getByText("Save failed")).toBeInTheDocument();
    });
  });

  it("shows error on load failure", async () => {
    mockGetAvatarSettings.mockRejectedValue(new Error("Load failed"));
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load avatar settings")).toBeInTheDocument();
    });
  });

  it("shows user count badges", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    expect(screen.getByTestId("avatar-users-wizard")).toHaveTextContent("5 users");
    expect(screen.getByTestId("avatar-users-pirate")).toHaveTextContent("2 users");
    expect(screen.getByTestId("avatar-users-moon")).toHaveTextContent("1 user");
  });

  it("filters by search query", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    const searchInput = screen.getByTestId("avatars-search");
    fireEvent.change(searchInput, { target: { value: "wizard" } });

    expect(screen.getByTestId("avatar-card-wizard")).toBeInTheDocument();
    expect(screen.queryByTestId("avatar-card-pirate")).not.toBeInTheDocument();
  });

  it("filters by enabled/disabled status", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    // Filter to disabled only
    fireEvent.click(screen.getByTestId("avatars-filter-disabled"));
    expect(screen.getByTestId("avatar-card-pirate")).toBeInTheDocument();
    expect(screen.queryByTestId("avatar-card-wizard")).not.toBeInTheDocument();

    // Filter to enabled only
    fireEvent.click(screen.getByTestId("avatars-filter-enabled"));
    expect(screen.getByTestId("avatar-card-wizard")).toBeInTheDocument();
    expect(screen.queryByTestId("avatar-card-pirate")).not.toBeInTheDocument();

    // Back to all
    fireEvent.click(screen.getByTestId("avatars-filter-all"));
    expect(screen.getByTestId("avatar-card-wizard")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-card-pirate")).toBeInTheDocument();
  });

  it("enable all button enables all avatars", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    // pirate is initially disabled
    expect(screen.getByTestId("avatar-card-pirate").className).toContain("avatar-disabled");

    fireEvent.click(screen.getByTestId("avatars-enable-all"));

    // All should be enabled now
    expect(screen.getByTestId("avatar-card-pirate").className).not.toContain("avatar-disabled");
    expect(screen.getByTestId("avatar-card-wizard").className).not.toContain("avatar-disabled");
  });

  it("disable all button disables all avatars", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("avatars-disable-all"));

    // All should be disabled now
    expect(screen.getByTestId("avatar-card-wizard").className).toContain("avatar-disabled");
    expect(screen.getByTestId("avatar-card-pirate").className).toContain("avatar-disabled");
    expect(screen.getByTestId("avatar-card-yeti").className).toContain("avatar-disabled");
  });

  it("shows correct enabled/disabled counts in summary", async () => {
    mockGetAvatarSettings.mockResolvedValue(mockSettings);
    render(<AdminAvatarsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-avatars-page")).toBeInTheDocument();
    });

    // 5 avatars total, 1 disabled
    expect(screen.getByText("4 enabled, 1 disabled")).toBeInTheDocument();
  });
});
