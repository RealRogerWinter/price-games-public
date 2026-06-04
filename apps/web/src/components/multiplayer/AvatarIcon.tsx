import type { Avatar } from "@price-game/shared";
import { DEFAULT_AVATAR, AVATAR_LABELS } from "@price-game/shared";

import rainCloud from "../../assets/avatars/rain-cloud.webp";
import moon from "../../assets/avatars/moon.webp";
import sun from "../../assets/avatars/sun.webp";
import cactusCowboy from "../../assets/avatars/cactus-cowboy.webp";
import jackOLantern from "../../assets/avatars/jack-o-lantern.webp";
import fancyGhost from "../../assets/avatars/fancy-ghost.webp";
import snowman from "../../assets/avatars/snowman.webp";
import iceCream from "../../assets/avatars/ice-cream.webp";
import bubbleTea from "../../assets/avatars/bubble-tea.webp";
import hotPepper from "../../assets/avatars/hot-pepper.webp";
import friedEgg from "../../assets/avatars/fried-egg.webp";
import sushi from "../../assets/avatars/sushi.webp";
import fortuneCookie from "../../assets/avatars/fortune-cookie.webp";
import pizza from "../../assets/avatars/pizza.webp";
import babyDragon from "../../assets/avatars/baby-dragon.webp";
import vampireBat from "../../assets/avatars/vampire-bat.webp";
import yeti from "../../assets/avatars/yeti.webp";
import ufo from "../../assets/avatars/ufo.webp";
import rocket from "../../assets/avatars/rocket.webp";
import wizard from "../../assets/avatars/wizard.webp";
import pirate from "../../assets/avatars/pirate.webp";
import ninjaFrog from "../../assets/avatars/ninja-frog.webp";
import divingHelmet from "../../assets/avatars/diving-helmet.webp";
import magic8Ball from "../../assets/avatars/magic-8-ball.webp";
import grimReaper from "../../assets/avatars/grim-reaper.webp";
import goldCoin from "../../assets/avatars/gold-coin.webp";
import cashStack from "../../assets/avatars/cash-stack.webp";
import piggyBank from "../../assets/avatars/piggy-bank.webp";
import moneyBag from "../../assets/avatars/money-bag.webp";
import creditCard from "../../assets/avatars/credit-card.webp";
import diamond from "../../assets/avatars/diamond.webp";
import goldBar from "../../assets/avatars/gold-bar.webp";
import treasureChest from "../../assets/avatars/treasure-chest.webp";
import priceTag from "../../assets/avatars/price-tag.webp";
import shoppingCart from "../../assets/avatars/shopping-cart.webp";
import shoppingBag from "../../assets/avatars/shopping-bag.webp";
import giftBox from "../../assets/avatars/gift-box.webp";
import calculator from "../../assets/avatars/calculator.webp";
import cashRegister from "../../assets/avatars/cash-register.webp";
import vault from "../../assets/avatars/vault.webp";
import carnivalClown from "../../assets/avatars/carnival-clown.webp";
import cottonCandy from "../../assets/avatars/cotton-candy.webp";
import ferrisWheel from "../../assets/avatars/ferris-wheel.webp";
import circusTent from "../../assets/avatars/circus-tent.webp";
import strongman from "../../assets/avatars/strongman.webp";
import smartphone from "../../assets/avatars/smartphone.webp";
import tablet from "../../assets/avatars/tablet.webp";
import smartwatch from "../../assets/avatars/smartwatch.webp";
import earbuds from "../../assets/avatars/earbuds.webp";
import laptop from "../../assets/avatars/laptop.webp";
import topHat from "../../assets/avatars/top-hat.webp";
import boot from "../../assets/avatars/boot.webp";
import iron from "../../assets/avatars/iron.webp";
import thimble from "../../assets/avatars/thimble.webp";
import wheelbarrow from "../../assets/avatars/wheelbarrow.webp";
import battleship from "../../assets/avatars/battleship.webp";
import scottieDog from "../../assets/avatars/scottie-dog.webp";
import raceCar from "../../assets/avatars/race-car.webp";
import monsterTruck from "../../assets/avatars/monster-truck.webp";
import taxiCab from "../../assets/avatars/taxi-cab.webp";
import fireTruck from "../../assets/avatars/fire-truck.webp";
import convertible from "../../assets/avatars/convertible.webp";

// The "silhouette" avatar has no PNG — it renders as an inline SVG
// placeholder (see AvatarIcon below). We keep it out of AVATAR_IMAGES and
// branch on the name instead of pointing at a sentinel image file.
const AVATAR_IMAGES: Record<Exclude<Avatar, "silhouette">, string> = {
  "rain-cloud": rainCloud,
  "moon": moon,
  "sun": sun,
  "cactus-cowboy": cactusCowboy,
  "jack-o-lantern": jackOLantern,
  "fancy-ghost": fancyGhost,
  "snowman": snowman,
  "ice-cream": iceCream,
  "bubble-tea": bubbleTea,
  "hot-pepper": hotPepper,
  "fried-egg": friedEgg,
  "sushi": sushi,
  "fortune-cookie": fortuneCookie,
  "pizza": pizza,
  "baby-dragon": babyDragon,
  "vampire-bat": vampireBat,
  "yeti": yeti,
  "ufo": ufo,
  "rocket": rocket,
  "wizard": wizard,
  "pirate": pirate,
  "ninja-frog": ninjaFrog,
  "diving-helmet": divingHelmet,
  "magic-8-ball": magic8Ball,
  "grim-reaper": grimReaper,
  "gold-coin": goldCoin,
  "cash-stack": cashStack,
  "piggy-bank": piggyBank,
  "money-bag": moneyBag,
  "credit-card": creditCard,
  "diamond": diamond,
  "gold-bar": goldBar,
  "treasure-chest": treasureChest,
  "price-tag": priceTag,
  "shopping-cart": shoppingCart,
  "shopping-bag": shoppingBag,
  "gift-box": giftBox,
  "calculator": calculator,
  "cash-register": cashRegister,
  "vault": vault,
  "carnival-clown": carnivalClown,
  "cotton-candy": cottonCandy,
  "ferris-wheel": ferrisWheel,
  "circus-tent": circusTent,
  "strongman": strongman,
  "smartphone": smartphone,
  "tablet": tablet,
  "smartwatch": smartwatch,
  "earbuds": earbuds,
  "laptop": laptop,
  "top-hat": topHat,
  "boot": boot,
  "iron": iron,
  "thimble": thimble,
  "wheelbarrow": wheelbarrow,
  "battleship": battleship,
  "scottie-dog": scottieDog,
  "race-car": raceCar,
  "monster-truck": monsterTruck,
  "taxi-cab": taxiCab,
  "fire-truck": fireTruck,
  "convertible": convertible,
};

interface AvatarIconProps {
  avatar: Avatar;
  size?: number;
  dimmed?: boolean;
}

/**
 * Renders a player avatar as a PNG sticker. Unknown avatar names (e.g. legacy
 * data from before the sticker-pop set) fall back to {@link DEFAULT_AVATAR}.
 * The special "silhouette" avatar renders as an inline SVG placeholder so
 * users who prefer to remain anonymous can still pick a real option rather
 * than leaving the field empty.
 *
 * @param avatar - The avatar identifier.
 * @param size - Diameter in pixels (default 32).
 * @param dimmed - Apply reduced opacity (used for disconnected players).
 */
export default function AvatarIcon({ avatar, size = 32, dimmed }: AvatarIconProps) {
  const label = AVATAR_LABELS[avatar] ?? AVATAR_LABELS[DEFAULT_AVATAR];

  if (avatar === "silhouette") {
    return (
      <span
        className={`avatar-icon avatar-icon-silhouette ${dimmed ? "avatar-dimmed" : ""}`}
        style={{ width: size, height: size }}
        role="img"
        aria-label={label}
      >
        <svg
          viewBox="0 0 24 24"
          width={Math.round(size * 0.65)}
          height={Math.round(size * 0.65)}
          aria-hidden="true"
        >
          <circle cx="12" cy="8" r="4" fill="currentColor" />
          <path d="M4 20c0-4 4-7 8-7s8 3 8 7" fill="currentColor" />
        </svg>
      </span>
    );
  }

  const src = AVATAR_IMAGES[avatar] ?? AVATAR_IMAGES[DEFAULT_AVATAR];
  return (
    <span
      className={`avatar-icon ${dimmed ? "avatar-dimmed" : ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      <img src={src} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}
