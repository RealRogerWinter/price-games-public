import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AvatarIcon from "../components/multiplayer/AvatarIcon";
import { AVATARS } from "@price-game/shared";

describe("AvatarIcon", () => {
  it("renders an img for the wizard avatar", () => {
    render(<AvatarIcon avatar="wizard" />);
    const icon = screen.getByRole("img", { name: "Wizard" });
    const img = icon.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBeTruthy();
  });

  it("renders an img for every avatar in AVATARS", () => {
    for (const avatar of AVATARS) {
      const { unmount } = render(<AvatarIcon avatar={avatar} />);
      // Every avatar should render a role=img wrapper. The "silhouette"
      // option is special-cased: it paints an inline <svg> placeholder
      // instead of a PNG <img>, so we accept either child element.
      const imgs = screen.getAllByRole("img");
      expect(imgs.length).toBeGreaterThan(0);
      const wrapper = imgs[0];
      if (avatar === "silhouette") {
        expect(wrapper.querySelector("svg")).toBeTruthy();
      } else {
        expect(wrapper.querySelector("img")).toBeTruthy();
      }
      unmount();
    }
  });

  it("falls back to the default avatar for unknown values", () => {
    // @ts-expect-error testing unknown avatar value (legacy DB data)
    render(<AvatarIcon avatar="bear" />);
    // Falls back to wizard's label because "bear" is not in the current AVATARS.
    const icon = screen.getByRole("img", { name: "Wizard" });
    expect(icon.querySelector("img")).toBeTruthy();
  });

  it("applies custom size styling", () => {
    render(<AvatarIcon avatar="sushi" size={48} />);
    const icon = screen.getByRole("img", { name: "Salmon Nigiri" });
    expect(icon.style.width).toBe("48px");
    expect(icon.style.height).toBe("48px");
  });

  it("uses default size of 32", () => {
    render(<AvatarIcon avatar="pizza" />);
    const icon = screen.getByRole("img", { name: "Cool Pizza" });
    expect(icon.style.width).toBe("32px");
    expect(icon.style.height).toBe("32px");
  });

  it("applies dimmed class when dimmed prop is true", () => {
    render(<AvatarIcon avatar="yeti" dimmed />);
    const icon = screen.getByRole("img", { name: "Cozy Yeti" });
    expect(icon.classList.contains("avatar-dimmed")).toBe(true);
  });

  it("does not apply dimmed class by default", () => {
    render(<AvatarIcon avatar="yeti" />);
    const icon = screen.getByRole("img", { name: "Cozy Yeti" });
    expect(icon.classList.contains("avatar-dimmed")).toBe(false);
  });
});
