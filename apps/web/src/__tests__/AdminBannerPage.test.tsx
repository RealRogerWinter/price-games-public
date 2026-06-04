import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../api/adminClient", () => ({
  getPromoBanner: vi.fn(),
  updatePromoBanner: vi.fn(),
}));

import * as adminClient from "../api/adminClient";
import AdminBannerPage from "../pages/admin/AdminBannerPage";

const mockGetPromoBanner = vi.mocked(adminClient.getPromoBanner);
const mockUpdatePromoBanner = vi.mocked(adminClient.updatePromoBanner);

/** A minimal PromoBanner fixture that represents a fully-configured banner. */
const defaultBanner = {
  enabled: true,
  audienceMode: "all" as const,
  text: "Win a prize this month!",
  showLink: false,
  linkText: "Learn More",
  linkUrl: "/prizes",
  showGiveawayModal: false,
  showTracker: false,
  giveawayMinPoints: 20000,
  giveawayMinStreak: 0,
  giveawayQualifyMode: "points_only" as const,
  qualifiedMessage: "You're entered in the {month} drawing!",
};

describe("AdminBannerPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading spinner while fetching banner settings", () => {
    // Never resolve so we stay in the loading state
    mockGetPromoBanner.mockReturnValue(new Promise(() => {}));
    render(<AdminBannerPage />);
    expect(screen.getByText(/loading banner settings/i)).toBeInTheDocument();
  });

  it("renders the form after banner data loads", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-banner-page")).toBeInTheDocument();
    });

    expect(screen.getByTestId("banner-settings")).toBeInTheDocument();
    expect(screen.getByTestId("banner-enabled")).toBeInTheDocument();
    expect(screen.getByTestId("banner-audience")).toBeInTheDocument();
    expect(screen.getByTestId("banner-text")).toBeInTheDocument();
    expect(screen.getByTestId("banner-save")).toBeInTheDocument();
  });

  it("displays the banner text from the loaded data", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-text")).toBeInTheDocument();
    });

    const input = screen.getByTestId("banner-text") as HTMLInputElement;
    expect(input.value).toBe("Win a prize this month!");
  });

  it("shows the enabled checkbox as checked when banner is enabled", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, enabled: true });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-enabled")).toBeInTheDocument();
    });

    const checkbox = screen.getByTestId("banner-enabled") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("shows the enabled checkbox as unchecked when banner is disabled", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, enabled: false });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-enabled")).toBeInTheDocument();
    });

    const checkbox = screen.getByTestId("banner-enabled") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("toggles the enabled state when the checkbox is clicked", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, enabled: true });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-enabled")).toBeInTheDocument();
    });

    const checkbox = screen.getByTestId("banner-enabled") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("updates banner text when user types in the text input", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-text")).toBeInTheDocument();
    });

    const input = screen.getByTestId("banner-text") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New banner text!" } });
    expect(input.value).toBe("New banner text!");
  });

  it("calls updatePromoBanner with current banner state on save", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    mockUpdatePromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("banner-save"));

    await waitFor(() => {
      expect(mockUpdatePromoBanner).toHaveBeenCalledWith(expect.objectContaining({
        text: "Win a prize this month!",
      }));
    });
  });

  it("shows success message after a successful save", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    mockUpdatePromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("banner-save"));

    await waitFor(() => {
      expect(screen.getByText("Banner settings saved")).toBeInTheDocument();
    });
  });

  it("shows error message when save fails", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    mockUpdatePromoBanner.mockRejectedValue(new Error("Network error"));
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("banner-save"));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("does not render the form section when banner load fails (stays in loading state)", async () => {
    // When getPromoBanner rejects, banner remains null so the component renders
    // the loading screen rather than the form (the error state is set internally
    // but cannot be shown because the early-return guard prevents form rendering).
    mockGetPromoBanner.mockRejectedValue(new Error("Network failure"));
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.queryByTestId("banner-settings")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/loading banner settings/i)).toBeInTheDocument();
  });

  it("shows live preview when banner is enabled and has text", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, enabled: true, text: "Big giveaway!" });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-preview")).toBeInTheDocument();
    });

    expect(screen.getAllByText("Big giveaway!").length).toBeGreaterThan(0);
  });

  it("hides live preview when banner is disabled", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, enabled: false, text: "Big giveaway!" });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-settings")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("banner-preview")).not.toBeInTheDocument();
  });

  it("hides live preview when banner text is empty", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, enabled: true, text: "" });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-settings")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("banner-preview")).not.toBeInTheDocument();
  });

  it("changes audience mode when select is changed", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, audienceMode: "all" });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-audience")).toBeInTheDocument();
    });

    const select = screen.getByTestId("banner-audience") as HTMLSelectElement;
    expect(select.value).toBe("all");

    fireEvent.change(select, { target: { value: "logged_in" } });
    expect(select.value).toBe("logged_in");
  });

  it("toggles the show-link checkbox", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, showLink: false });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-show-link")).toBeInTheDocument();
    });

    const checkbox = screen.getByTestId("banner-show-link") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it("toggles the show-giveaway-modal checkbox", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, showGiveawayModal: false });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-show-giveaway-modal")).toBeInTheDocument();
    });

    const checkbox = screen.getByTestId("banner-show-giveaway-modal") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it("toggles the show-tracker checkbox", async () => {
    mockGetPromoBanner.mockResolvedValue({ ...defaultBanner, showTracker: false });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-show-tracker")).toBeInTheDocument();
    });

    const checkbox = screen.getByTestId("banner-show-tracker") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it("updates giveaway min points when value changes", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-giveaway-min-points")).toBeInTheDocument();
    });

    const input = screen.getByTestId("banner-giveaway-min-points") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "15000" } });
    expect(input.value).toBe("15000");
  });

  it("updates qualified message when text changes", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-qualified-message")).toBeInTheDocument();
    });

    const textarea = screen.getByTestId("banner-qualified-message") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Congrats, you qualified!" } });
    expect(textarea.value).toBe("Congrats, you qualified!");
  });

  it("shows giveaway mode select with default points_only", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-giveaway-mode")).toBeInTheDocument();
    });

    const select = screen.getByTestId("banner-giveaway-mode") as HTMLSelectElement;
    expect(select.value).toBe("points_only");
    expect(screen.queryByTestId("banner-giveaway-min-streak")).not.toBeInTheDocument();
  });

  it("streak_only mode hides points input and shows streak input", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-giveaway-mode")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("banner-giveaway-mode"), {
      target: { value: "streak_only" },
    });

    expect(screen.queryByTestId("banner-giveaway-min-points")).not.toBeInTheDocument();
    expect(screen.getByTestId("banner-giveaway-min-streak")).toBeInTheDocument();
  });

  it("points_or_streak mode shows both inputs", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-giveaway-mode")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("banner-giveaway-mode"), {
      target: { value: "points_or_streak" },
    });

    expect(screen.getByTestId("banner-giveaway-min-points")).toBeInTheDocument();
    expect(screen.getByTestId("banner-giveaway-min-streak")).toBeInTheDocument();
  });

  it("saves streak fields through the API", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    mockUpdatePromoBanner.mockResolvedValue({ ...defaultBanner, giveawayMinStreak: 7, giveawayQualifyMode: "streak_only" });
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-giveaway-mode")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("banner-giveaway-mode"), {
      target: { value: "streak_only" },
    });
    fireEvent.change(screen.getByTestId("banner-giveaway-min-streak"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByTestId("banner-save"));

    await waitFor(() => {
      expect(mockUpdatePromoBanner).toHaveBeenCalledWith(
        expect.objectContaining({ giveawayMinStreak: 7, giveawayQualifyMode: "streak_only" }),
      );
    });
  });

  it("disables save button while saving", async () => {
    mockGetPromoBanner.mockResolvedValue(defaultBanner);
    // Delay the save to observe the disabled state
    mockUpdatePromoBanner.mockReturnValue(new Promise(() => {}));
    render(<AdminBannerPage />);

    await waitFor(() => {
      expect(screen.getByTestId("banner-save")).toBeInTheDocument();
    });

    const saveBtn = screen.getByTestId("banner-save") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    fireEvent.click(saveBtn);
    expect(saveBtn.disabled).toBe(true);
    expect(saveBtn.textContent).toBe("Saving...");
  });
});
