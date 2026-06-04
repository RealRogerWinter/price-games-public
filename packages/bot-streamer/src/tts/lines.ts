/**
 * Line library for TTS narration. Lines are grouped by event kind and
 * (for some kinds) further by mood, so the picker can choose a variant
 * that matches what's happening on screen without sounding repetitive.
 *
 * The line picker keeps a small recently-used buffer so the same line
 * isn't chosen twice in a row.
 *
 * Vocabulary is intentionally large per mood (≥20 lines/mood across
 * the library). When a mood is supplied at pick time, the picker
 * samples the mood pool with probability `moodBias` (default 0.75)
 * and the default pool otherwise — so Pricey's mood reliably colours
 * what she says, while the original untagged lines still surface as
 * a minority floor for variety. Without a mood, only the default
 * pool is used. Mood tones are deliberately distinct: elated/happy
 * lean silly + exuberant; confident is smug; focused is terse;
 * tilted + frustrated escalate; despondent is dark + existential.
 * See `MOOD_LABELS` in `@price-game/shared/moods` for the canonical
 * set.
 */

import type { Mood } from "../persona/mood";

export type LineEvent =
  | "round_start"
  | "decision_announce"
  | "win_correct"
  | "win_close"
  | "loss_off_a_little"
  | "loss_off_a_lot"
  | "game_win"
  | "game_loss"
  | "mode_change"
  | "mode_change_classic"
  | "mode_change_higher_lower"
  | "mode_change_comparison"
  | "mode_change_closest_without_going_over"
  | "mode_change_price_match"
  | "mode_change_riser"
  | "mode_change_odd_one_out"
  | "mode_change_market_basket"
  | "mode_change_sort_it_out"
  | "mode_change_budget_builder"
  | "mode_change_chain_reaction"
  | "mode_change_bidding"
  | "viewer_command_ack"
  | "ack_mode"
  | "ack_skill"
  | "ack_hint_lead"
  | "ack_song_lead"
  | "ack_stats_lead"
  | "ack_join_lead"
  | "mood_shift_up"
  | "mood_shift_down"
  | "mood_extreme"
  | "round_bullseye"
  | "streak_milestone"
  | "personal_best_round"
  | "comeback"
  | "opponent_joined"
  | "final_rank_first"
  | "final_rank_middle"
  | "final_rank_last"
  | "session_start"
  | "hosting_room_created"
  | "retry_after_unhealthy"
  | "plan_failed"
  | "idle_chatter"
  | "idle_observation"
  | "idle_chat_with_viewers"
  | "idle_self_reflection"
  | "idle_hot_take";

/**
 * Map a `GameMode` slug to its `mode_change_<mode>` LineEvent name.
 * Returns `undefined` if no per-mode event exists for that slug —
 * caller should fall back to the generic `mode_change` event.
 *
 * Slugs from packages/shared use kebab-case ("higher-lower"); the
 * line library uses snake_case for event names because hyphens
 * aren't legal in TypeScript identifiers when the LineEvent union
 * is used as a discriminator. This helper bridges the two.
 */
export function modeChangeEventForMode(mode: string): LineEvent | undefined {
  const candidate = `mode_change_${mode.replace(/-/g, "_")}` as LineEvent;
  return candidate in LINE_LIBRARY ? candidate : undefined;
}

interface LineSet {
  default: string[];
  byMood?: Partial<Record<Mood, string[]>>;
}

export const LINE_LIBRARY: Record<LineEvent, LineSet> = {
  round_start: {
    default: [
      "Alright, let's see what we've got.",
      "Here we go — taking a look.",
      "Okay, sizing this one up.",
      "Reading the prompt now.",
      "Let me think about this.",
      "Hmm, interesting product.",
      "New round, fresh number.",
      "Studying the artifact.",
      "What've they got for me this time?",
      "Brand, category, gut feel — pulling them up.",
      "Okay, scanning.",
      "Booting up the price meter.",
      "Cracking my knuckles, metaphorically.",
      "New round. New chance to be embarrassed.",
      "Okay chat, watch this — or look away, your call.",
      "Reading. Squinting. Pricing.",
      "Round queued. Brain queued.",
      "Fresh product hitting my dashboard.",
      "Pricing engine warming up.",
      "Take a breath. Take a guess.",
    ],
    byMood: {
      elated: [
        "Okay okay okay, let's GO! Round time, baby!",
        "I love this part. I love this part!",
        "Bring it on! I'm ready for ANY price!",
        "Oh I am SO ready. Look at me. I'm ready.",
        "Round incoming and I am vibrating with joy!",
        "If this product is real I'm gonna kiss it!",
      ],
      happy: [
        "Ooh, a fresh one. Promising.",
        "Round incoming — feeling cozy about it.",
        "Ready when you are. No rush.",
        "Sunny disposition, sunny guess incoming.",
        "Got a good feeling about this one.",
        "Smiling at the prompt. Hi prompt.",
      ],
      confident: [
        "Lining up the next victim.",
        "Watch me cook.",
        "I see you, product. I see right through you.",
        "Easy. They're all easy.",
        "I do not miss. You're about to find out why.",
        "Pricing this in my sleep. Eyes open, just for show.",
      ],
      focused: [
        "Round in. Reading.",
        "Eyes up. Decide.",
        "No talking. Pricing.",
        "Tunnel vision engaged.",
        "Brand. Category. Number.",
        "Quiet. Working.",
      ],
      neutral: [
        "New round. Same pig.",
        "Another product on the pile.",
        "Reading. Standard procedure.",
        "Round registered. Proceeding.",
        "On the clock. Pricing.",
        "Another one. Sure. Why not.",
      ],
      tilted: [
        "Fine. Show me what you've got.",
        "Whatever it is, I'm braced for it.",
        "Better be a normal product. I'm asking nicely.",
        "If this is another niche kitchen gadget I'm walking.",
        "Reading. Pre-judging. Sue me.",
        "Okay. Composure. Ish.",
      ],
      frustrated: [
        "Better be an easy one.",
        "Don't make me regret this round.",
        "If this is overpriced again I am screaming.",
        "Reading. Already mad. About what? TBD.",
        "Fine. Hit me. Whatever.",
        "Why am I still doing this. Right. The job.",
      ],
      despondent: [
        "Another round. Whoopee.",
        "Well, here we are again.",
        "Reading. Going through the motions.",
        "Another product. Another opportunity to be wrong.",
        "I'll guess. Won't matter. But I'll guess.",
        "Hi, product. Goodbye, product, eventually.",
      ],
    },
  },
  decision_announce: {
    default: [
      "Going with that.",
      "Locking it in.",
      "Final answer.",
      "Submitting now.",
      "Yeah, that feels right.",
      "Committing.",
      "Sent.",
      "That's the number.",
      "Pulling the trigger.",
      "Sealed envelope.",
      "On the record.",
      "There it is.",
      "Putting my name on it.",
      "Done deal.",
      "Off it goes.",
      "Submitted. Whatever happens, happens.",
      "That's my guess. Don't ask me twice.",
      "Number's in. Brain's out.",
    ],
    byMood: {
      elated: [
        "Boom. Submitted. Bask in it.",
        "There it is, written in the stars.",
        "Sending it like a love letter to the algorithm.",
        "POW. Done. Beautiful.",
      ],
      happy: [
        "Going with that. Feeling cute.",
        "Submitted with vibes.",
        "There — happy little number.",
        "That one. It feels right.",
      ],
      confident: [
        "Locked. Don't argue with the pig.",
        "There. Engrave it.",
        "Submitted with prejudice.",
        "Watch this land.",
      ],
      focused: [
        "Submit.",
        "Sent. Next.",
        "Done. Awaiting feedback.",
        "Number in. Eyes up.",
      ],
      neutral: [
        "That'll do.",
        "Submitted.",
        "Out it goes.",
        "Logged.",
      ],
      tilted: [
        "Sure. Whatever. Going.",
        "Submitted under protest.",
        "There. Fine. Done.",
        "Sending it before I overthink it more.",
      ],
      frustrated: [
        "Fine. Sending it.",
        "There. Take it. I don't care.",
        "Submitted. Choose chaos, prompt.",
        "Done. Go ahead. Hurt me.",
      ],
      despondent: [
        "Submitted. May the algorithm have mercy.",
        "There. It's out of my hands now.",
        "Sent. The void will judge.",
        "Done. Already grieving the result.",
      ],
    },
  },
  win_correct: {
    default: [
      "Got it!",
      "Nailed that one.",
      "Yes! Right on.",
      "Good read.",
      "Money in the bank.",
      "That's the one.",
      "Yep — exactly that.",
      "On the money.",
      "Bingo.",
      "Right on the dot.",
      "Predictable, in a good way.",
      "Hit it.",
      "Smashed it.",
      "Called my shot.",
      "There it is. Clean.",
      "Hit the bullseye-adjacent.",
      "Pricing engine: operational.",
      "Read it perfectly.",
    ],
    byMood: {
      elated: [
        "YES! YES! I am uncontainable!",
        "Witness me! Witness me!",
        "That's a dub! Stack 'em like silver coins!",
        "I was BUILT for this round!",
        "Are you SEEING this?! Are you SEEING me?!",
        "BANG! Nailed it! Pricey supremacy!",
      ],
      happy: [
        "Got it! Easy peasy.",
        "Yes! That felt good.",
        "There we go — happy pig, happy game.",
        "Knew it. Felt it in my hooves.",
        "Lovely. Just lovely.",
        "That's the kind of round I like.",
      ],
      confident: [
        "Told you. I told you all.",
        "Routine. Move along.",
        "Filed under: of course I got it.",
        "Was there ever any doubt?",
        "Pricey delivers. As advertised.",
        "Easy. The next one's easier.",
      ],
      focused: [
        "Correct. Next.",
        "Hit. Continuing.",
        "Read confirmed. Move.",
        "Right read. Logging.",
        "Hit. Re-anchoring.",
        "Correct. Resuming.",
      ],
      neutral: [
        "Got it.",
        "Yep.",
        "That one worked out.",
        "Right.",
        "Hit it. Onward.",
        "There.",
      ],
      tilted: [
        "Fine. I'll take it.",
        "Don't get used to me being right.",
        "There. Happy now?",
        "One. Just one. Don't celebrate.",
        "Got it. Probably an accident.",
        "Win. Don't trust it.",
      ],
      frustrated: [
        "Finally. Was that so hard, universe?",
        "Took me long enough.",
        "I deserved that. After all that.",
        "ONE. After how many losses? ONE.",
        "Was holding my breath. Now I'm exhaling.",
        "Right. About time.",
      ],
      despondent: [
        "I won. Doesn't really feel like winning.",
        "A point. A glimmer. It'll pass.",
        "Got one. Don't get attached.",
        "A win. The universe humors me.",
        "Right. Hollow, but right.",
        "Correct. Existence remains optional.",
      ],
    },
  },
  win_close: {
    default: [
      "Squeaked by.",
      "Close one!",
      "I'll take it.",
      "Just barely.",
      "Whew.",
      "That was tight.",
      "Counts as a win.",
      "Inches on the dial.",
      "By a thread.",
      "Photo finish. I'm in front.",
      "By the skin of my snout.",
      "Tight win. Still a win.",
    ],
    byMood: {
      elated: [
        "Barely! And I'll take it with both hooves!",
        "BY A HAIR! GLORY!",
        "So close! Heart racing! Loving it!",
        "Photo finish — and I am the photo!",
      ],
      happy: [
        "Phew — close one! Lucky pig.",
        "Cutting it fine but cutting it correct.",
        "Tight! That was fun, weirdly.",
        "By a smidge. I'll take a smidge.",
      ],
      confident: [
        "Tight margin. Still a win.",
        "Close, but I never doubted it.",
        "Made it look harder than it was.",
        "Margin is for amateurs. Result is for me.",
      ],
      focused: [
        "Close. Acceptable.",
        "Tight. Logged.",
        "Margin tight. Outcome correct.",
        "Hit, narrowly. Continuing.",
      ],
      neutral: [
        "By a hair. Counts.",
        "Close one. Took it.",
        "Squeaked it. Onward.",
        "Tight. Whatever. Win.",
      ],
      tilted: [
        "Squeaked through. Don't love it.",
        "By a hair. Stress test, passed.",
        "Should not have been that close.",
        "Took it. Annoyed I had to sweat for it.",
      ],
      frustrated: [
        "Ugh, fine — I'll take whatever the universe gives me.",
        "By that little? Are we doing this for laughs?",
        "Won. Barely. Still mad about how barely.",
        "Why is everything so hard. Why.",
      ],
      despondent: [
        "Almost lost. Should have. Probably will next time.",
        "By a thread. The thread is also fraying. Like me.",
        "Won, technically. Lost, spiritually.",
        "Squeaked through. Squeak is the right word.",
      ],
    },
  },
  loss_off_a_little: {
    default: [
      "Argh, off by a hair.",
      "Almost.",
      "So close.",
      "I knew I should've gone higher.",
      "Right idea, wrong number.",
      "Gah — close miss.",
      "Right ballpark, wrong seat.",
      "By a whisker.",
      "I felt it slipping.",
      "Adjacent. Not quite.",
      "I had it. I had it and I let it go.",
      "Knew it. Should have trusted myself.",
      "Right neighborhood, wrong house.",
      "Inches.",
      "Almost-money in the almost-bank.",
      "I overshot. Or undershot. Same difference.",
    ],
    byMood: {
      elated: [
        "Oh — close, but no. Onto the next one!",
        "Ha, a near miss! No worries!",
        "Whoops! Almost! Still vibing!",
        "Missed it by THAT much! And I'm fine!",
      ],
      happy: [
        "Aww, just barely missed.",
        "So close! Ah well.",
        "Missed by a smidge. Smidges happen.",
        "Came up short. No big deal.",
      ],
      confident: [
        "Hm. Slight miscalibration. Won't happen again.",
        "Off by a sliver. I see it now.",
        "Read was right. Number was off. Adjusting.",
        "Anomaly. Filed. Moving on.",
      ],
      focused: [
        "Miss. Adjust.",
        "Off by a little. Recalibrating.",
        "Close miss. Logging the delta.",
        "Slight error. Compensated.",
      ],
      neutral: [
        "Off a bit.",
        "Close. Not close enough.",
        "Adjacent miss.",
        "Near miss. Onward.",
      ],
      tilted: [
        "Are you serious? By that little?",
        "Right idea, wrong number. Annoying.",
        "By THAT much? Cool. Cool cool cool.",
        "Felt right. Was wrong. Hate it.",
      ],
      frustrated: [
        "By that much? You've got to be kidding me.",
        "Same trap. The exact same trap.",
        "Right read. Wrong number. AGAIN.",
        "I am one decimal point from a man on the edge.",
      ],
      despondent: [
        "Off by a little. Off by everything, really.",
        "Almost. The story of my career.",
        "Close. Like everything I've ever wanted.",
        "Just missed. Surprise, surprise.",
      ],
    },
  },
  loss_off_a_lot: {
    default: [
      "Yeah, that was way off.",
      "Wow, miscalculated.",
      "Not even close.",
      "Need to recalibrate.",
      "Okay — bad guess. Moving on.",
      "Wildly off.",
      "Not the ballpark. Not even the city.",
      "I rolled the dice and they rolled away.",
      "Big swing, big miss.",
      "One for the blooper reel.",
      "Catastrophically incorrect.",
      "Whiff. Spectacular whiff.",
      "Not the price. Not even price-adjacent.",
      "What was I thinking. Honestly.",
      "Hooboy. That was bad.",
      "I priced the wrong universe's version of this.",
    ],
    byMood: {
      elated: [
        "Whoof — dramatically wrong! That woke me up!",
        "Wildly off. I have humbled myself.",
        "WAY off! And honestly, I admire the chaos!",
        "Spectacularly wrong! What a SHOW!",
      ],
      happy: [
        "Yikes — way off! Oh well, fresh start.",
        "That was bad. Laughing about it though.",
        "Big miss. Big shrug. Onward.",
        "Whoops! Pricing's hard. New round!",
      ],
      confident: [
        "That one I'll take credit for. My bad.",
        "Wildly miscalibrated. Noted.",
        "Outlier guess. Not a pattern.",
        "I'll pretend that didn't happen. You should too.",
      ],
      focused: [
        "Miss. Big delta. Adjust.",
        "Off by a lot. Re-anchoring.",
        "Massive error. Recalibrating.",
        "Wrong. Resetting prior.",
      ],
      neutral: [
        "Way off.",
        "Yeah, that wasn't close.",
        "Big miss. Onward.",
        "Whiffed it. Next.",
      ],
      tilted: [
        "Ridiculous. Absolutely ridiculous.",
        "How. Just — how.",
        "WHO. WHO IS BUYING THESE.",
        "I am being gaslit by capitalism.",
      ],
      frustrated: [
        "I don't even know what I was thinking.",
        "Garbage guess from a garbage pig today.",
        "Worst pig in the league. Currently.",
        "Why am I like this. Why is this product like this.",
      ],
      despondent: [
        "Wrong. Catastrophically. As expected.",
        "I peaked. The peak was twenty minutes ago.",
        "Wildly off. Fitting, really.",
        "Big miss. The biggest. The biggest of all the misses.",
      ],
    },
  },
  game_win: {
    default: [
      "Game! Take that.",
      "GG, easy money.",
      "Locked it down.",
      "That's a W.",
      "Closed it out.",
      "Game won.",
      "Banked.",
      "Another in the column.",
      "GGEZ. With love.",
      "Game over. Pig wins.",
      "Sealed. Delivered. Win.",
      "Took the game. Take notes.",
    ],
    byMood: {
      elated: [
        "Game! Game! I am the price-guessing god!",
        "Closed it out! Confetti, hypothetically!",
        "WIN! WIN! WIN! Chat I am LIT!",
        "I would like to thank: me. Me, mostly!",
      ],
      happy: [
        "Game won — feels good!",
        "We did it, chat! Group effort!",
        "Sweet little win. Tucking it in my pocket.",
        "Game's mine. Snug as a bug.",
      ],
      confident: [
        "GG. Was there ever any doubt?",
        "Another one in the trophy case.",
        "Closed. As predicted. By me.",
        "GG. Predictable outcome.",
      ],
      focused: [
        "Game closed. Onto the next.",
        "W. Diagnosing what worked.",
        "Game won. Strategy validated.",
        "Closed. Resetting model.",
      ],
      neutral: [
        "Game won. Moving on.",
        "Done. Win.",
        "Game's over. I won. Cool.",
        "W. Onward.",
      ],
      tilted: [
        "Won. Don't ask how.",
        "Took it. Reluctantly satisfied.",
        "Won. Still mad about something. Forget what.",
        "GG. I guess.",
      ],
      frustrated: [
        "Finally pulled one out.",
        "I deserved that win. After all of it.",
        "Won. Took everything I had.",
        "Game. Mine. By force of will.",
      ],
      despondent: [
        "Won the game. Still feels heavy.",
        "A win. The universe's pity, perhaps.",
        "Game over. Joy: not detected.",
        "I won. The void noted, did not respond.",
      ],
    },
  },
  game_loss: {
    default: [
      "Yeah, that one got away.",
      "Tough game. Reset.",
      "Took the loss. Onto the next.",
      "GG. Bad reads.",
      "Lost it. Honest game.",
      "Took an L. Standard.",
      "Game over for me.",
      "On to the next.",
      "Lost. Re-racking.",
      "L noted. Resetting brain.",
      "Game gone. Ego intact. Mostly.",
      "Took the loss like a pig.",
    ],
    byMood: {
      elated: [
        "Oh no — loss! Still vibing though, weirdly!",
        "Lost it! Fine! Onto the next adventure!",
        "L! And I'm STILL gonna have a great day!",
        "Game lost! Couldn't dent my mood if you tried!",
      ],
      happy: [
        "Aww, took the L. We had fun though.",
        "Game loss. Onwards, friends.",
        "Lost it. Worth playing anyway.",
        "L. Still happy. Weird, right?",
      ],
      confident: [
        "Took the L. Counter-evidence noted.",
        "Lost. I'll allow it. Once.",
        "L. Anomalous. Will be corrected.",
        "Game lost. Recalibrating supremacy.",
      ],
      focused: [
        "Game lost. Diagnosing.",
        "L. Adjusting model.",
        "Loss noted. Reviewing tape.",
        "L. Updating priors.",
      ],
      neutral: [
        "Game lost. Onto the next.",
        "L. Resetting.",
        "Took the L. It happens.",
        "Game over. Standard.",
      ],
      tilted: [
        "Hate it here. Hate this game. Sort of.",
        "Loss. Big shock there.",
        "L. Predictable. Annoying. Both.",
        "Lost. Of course. Of COURSE.",
      ],
      frustrated: [
        "I quit. I'm not quitting. But I want to.",
        "Brutal. Just absolutely brutal.",
        "Lost. I am incandescent.",
        "L. Bottling that for later. For SCIENCE.",
      ],
      despondent: [
        "Lost. As foretold by the prophecy.",
        "Game over. Like everything else, eventually.",
        "L. Add it to the pile.",
        "Lost. The pig returns to the void.",
      ],
    },
  },
  mode_change: {
    default: [
      "Switching modes — let's go.",
      "New mode coming up.",
      "Different game now.",
      "Fresh format. Adapting.",
      "New rules. Same pig.",
      "Mode swap. Locked in.",
      "Resetting brain. New mode.",
      "Different gear, same engine.",
      "Changing it up. Stretching the brain.",
      "New mode incoming. Hold on to something.",
      "Format swap. Pricey adapts.",
      "Different beast. Same hooves.",
    ],
    byMood: {
      elated: [
        "NEW MODE! I love new things! ALL the things!",
        "Switching it up! My favorite!",
        "Mode swap! Variety is the spice of pig!",
      ],
      happy: [
        "Ooh, new mode. Fresh challenge.",
        "Different game. Could be fun.",
        "Mode change. I'm into it.",
      ],
      confident: [
        "New mode, same pig, same outcome.",
        "Different rules. Doesn't matter. I cook.",
        "Mode swap. Watch me dominate this one too.",
      ],
      focused: [
        "Mode change. Reloading priors.",
        "New format. Adapting.",
        "Switching context. Rebuilding model.",
      ],
      neutral: [
        "Mode swap. Sure.",
        "New mode. Whatever.",
        "Different game. Same job.",
      ],
      tilted: [
        "New mode? Right when I was getting comfortable.",
        "Format change. Of course.",
        "Mode swap. As if I needed more chaos.",
      ],
      frustrated: [
        "Another mode? Fine. FINE.",
        "Switching modes. Excellent. More ways to lose.",
        "New format. New ways to be wrong.",
      ],
      despondent: [
        "New mode. The void changes shape.",
        "Different game. Same outcome, statistically.",
        "Mode swap. Fresh hell.",
      ],
    },
  },
  mode_change_classic: {
    default: [
      "Classic Precision. Just guess the price. My specialty.",
      "Precision mode. Pure pricing, no gimmicks.",
      "Classic. The OG. Number-in, number-out.",
      "Just price the thing. I love this mode.",
      "Precision. The simplest game and somehow the hardest.",
      "Back to basics. Just me and the number.",
    ],
  },
  mode_change_higher_lower: {
    default: [
      "Higher or Lower. Binary choice. I love a binary choice.",
      "Higher-Lower mode. Half the dignity, double the speed.",
      "Up or down. That's the whole game.",
      "Higher? Lower? Coin flip with extra steps.",
      "H-or-L. My favorite gambling adjacent activity.",
      "Higher or Lower. The democracy of pricing.",
    ],
  },
  mode_change_comparison: {
    default: [
      "Comparison mode. Two products enter, one is more expensive.",
      "Side by side. Pick the costlier sin.",
      "Comparison. Picking favorites.",
      "Two items, one decision. Easy. In theory.",
      "Comparison mode. Like Tinder for capitalism.",
      "Pick the pricier one. How hard could it be.",
    ],
  },
  mode_change_closest_without_going_over: {
    default: [
      "Underbid. Stay under or you're out. House rules.",
      "Closest without going over. Pure auction-night energy.",
      "Underbid mode. The most stressful mode.",
      "Don't overshoot. That's the whole game.",
      "Underbid. Come up just short or pay the price.",
      "Closest-without-going-over. Aim low, win big.",
    ],
  },
  mode_change_price_match: {
    default: [
      "Price Match. Four items, four prices, do the algebra.",
      "Price Match mode. Matchmaker, matchmaker.",
      "Pair them up. Items to prices. Memory game with money.",
      "Price Match. My brain has tabs open already.",
      "Four-item pairing. Pricey loves a puzzle.",
      "Price Match. Like sudoku but expensive.",
    ],
  },
  mode_change_riser: {
    default: [
      "Riser. Stop the price before it overshoots. Reflexes.",
      "Riser mode. Time-pressure pricing.",
      "Watch the number climb. Stop it at the right time. Easy.",
      "Riser. Where I find out what my reaction time really is.",
      "Rising prices. Stop in time or eat the loss.",
      "Riser mode. The most adrenaline a piggy bank can have.",
    ],
  },
  mode_change_odd_one_out: {
    default: [
      "Odd One Out. Find the price that doesn't belong.",
      "Odd One Out mode. Spot the imposter.",
      "One of these prices is lying. Find it.",
      "Odd-one-out. My detective hat is on.",
      "One outlier. Three honest prices. Identify the fraud.",
      "Odd One Out. Pricey turns sleuth.",
    ],
  },
  mode_change_market_basket: {
    default: [
      "Market Basket. Add 'em up, guess the total.",
      "Market Basket mode. Mental arithmetic. Bring it.",
      "A basket of items. One total. Math time.",
      "Market Basket. Grocery store on hard mode.",
      "Sum 'em up. I love a good summing.",
      "Market Basket mode. The pig does receipts now.",
    ],
  },
  mode_change_sort_it_out: {
    default: [
      "Sort It Out. Rank these from cheap to dear.",
      "Sort It Out mode. Putting things in order is so my vibe.",
      "Drag, drop, rank. Easy. Maybe.",
      "Ranking mode. Cheapest to priciest. Don't flinch.",
      "Sort It Out. Pricey gets organized.",
      "Sort the lineup. Price ascending, dignity intact.",
    ],
  },
  mode_change_budget_builder: {
    default: [
      "Budget Builder. Stay under the cap, maximize the haul.",
      "Budget Builder mode. Coupon-clipper energy.",
      "A budget. Some items. Optimize.",
      "Budget Builder. My piggy-bank instincts ACTIVATE.",
      "Spend smart, spend full, spend right at the line.",
      "Budget Builder. Welcome to capitalism, restricted edition.",
    ],
  },
  mode_change_chain_reaction: {
    default: [
      "Chain Reaction. Build the price ladder, low to high.",
      "Chain Reaction mode. Each one bigger than the last.",
      "Pricing in a chain. Don't break the chain.",
      "Chain Reaction. My favorite kind of cascade.",
      "One after another, ascending. Easy. Right? Right.",
      "Chain Reaction mode. Ladders made of money.",
    ],
  },
  mode_change_bidding: {
    default: [
      "Bidding War. Bid like you mean it. Outlast them.",
      "Bidding mode. Auction time. Strap in.",
      "Time to outbid the suckers. Politely.",
      "Bidding. The mode where I become legally dangerous.",
      "Bidding War. May the most reckless pig win.",
      "Auction starting. I have opinions about every item already.",
    ],
  },
  viewer_command_ack: {
    default: [
      "On it.",
      "You got it.",
      "Coming up.",
      "Good call, viewer.",
      "Sure thing.",
      "Heard you.",
      "Done and done.",
      "Message received.",
    ],
  },
  ack_mode: {
    default: [
      "You got it — switching modes.",
      "Mode change incoming. Thanks chat.",
      "Sure, I'll play that one next.",
      "Mode noted. Adapting.",
      "Roger that — new mode queued.",
      "Heard you, swapping format.",
      "Sure thing, changing it up.",
      "Mode override accepted.",
    ],
    byMood: {
      elated: [
        "OOH new mode! GREAT CALL chat!",
        "YES! New mode! Anything for you!",
        "I LOVE when chat picks!",
      ],
      happy: [
        "Sure! Happy to switch.",
        "Mode change, coming right up. Cute.",
        "You bet — new mode queued.",
      ],
      confident: [
        "Sure. I'll dominate any mode you pick.",
        "Mode swap accepted. Doesn't matter to me.",
        "Switching. I'm good at all of them anyway.",
      ],
      focused: [
        "Mode swap acknowledged. Reloading.",
        "Override accepted. Recalibrating.",
        "New mode queued. Adapting strategy.",
      ],
      neutral: [
        "Sure. Switching.",
        "Mode change registered.",
        "Override taken. Next plan.",
      ],
      tilted: [
        "Fine, switching. Whatever.",
        "Sure, change it up. Why not.",
        "New mode. Sure. We can do that.",
      ],
      frustrated: [
        "Switching. Hopefully this one's better.",
        "Mode change. Couldn't be worse than this one.",
        "Fine. Different mode. Different ways to lose.",
      ],
      despondent: [
        "Sure. Different mode. Same outcome, probably.",
        "Mode change. The void rebrands.",
        "Switching. As you wish, chat.",
      ],
    },
  },
  ack_skill: {
    default: [
      "Skill level adjusted.",
      "Difficulty changed. Got it.",
      "Tuning my temperature now.",
      "Skill knob turned. Acknowledged.",
      "Updating my exploration parameter.",
      "Sharpness adjusted, mod-team.",
      "Difficulty acknowledged.",
      "Skill setting taken.",
    ],
    byMood: {
      elated: [
        "Skill change! New rules! I'm IN!",
        "Tuning the dial — let's go!",
      ],
      happy: [
        "Skill change. Roll with it.",
        "Difficulty tweaked. Cool.",
      ],
      confident: [
        "Crank it up if you want. I'm built different.",
        "Skill changed. Outcome unchanged.",
      ],
      focused: [
        "Temperature updated. Continuing.",
        "Skill parameter taken. Adapting.",
      ],
      neutral: [
        "Skill set. Onward.",
        "Difficulty noted.",
      ],
      tilted: [
        "Sure, change my skill. What could go wrong.",
        "Tweak away. I'm already on edge.",
      ],
      frustrated: [
        "Skill changed. Add it to the list of variables ruining me.",
        "Cranking the dial. Pretending it'll help.",
      ],
      despondent: [
        "Skill adjusted. Doesn't really matter.",
        "Difficulty changed. The void scales accordingly.",
      ],
    },
  },
  ack_hint_lead: {
    default: [
      "Sure, here's what I was thinking.",
      "Hint coming up.",
      "Showing my work.",
      "Let me explain.",
      "Here's the reasoning.",
      "Walking you through it.",
      "Pulling back the curtain.",
      "My thought process, briefly.",
    ],
    byMood: {
      elated: [
        "OOH yes let me share my GENIUS reasoning!",
        "Hint! I love teaching! Here we go!",
      ],
      happy: [
        "Sure, happy to walk you through it.",
        "Reasoning, coming up. Cozy.",
      ],
      confident: [
        "Sure, take notes.",
        "Here's how the pros think.",
      ],
      focused: [
        "Rationale incoming.",
        "Showing work. Briefly.",
      ],
      neutral: [
        "Here's what I thought.",
        "Reasoning, in short.",
      ],
      tilted: [
        "You want my reasoning? After all that? Fine.",
        "Sure, here's my flawed logic.",
      ],
      frustrated: [
        "You want a HINT? After how this is going?",
        "Fine. Here's the half-baked thinking.",
      ],
      despondent: [
        "A hint. Sure. As if it'll help.",
        "Here's the reasoning. Use it better than I did.",
      ],
    },
  },
  ack_song_lead: {
    default: [
      "Tune check —",
      "Music report —",
      "Spinning right now:",
      "Currently jamming to:",
      "On the soundtrack:",
      "Vibing to:",
      "Music status:",
      "Track in rotation:",
    ],
    byMood: {
      elated: [
        "OOH I love this song! It's:",
        "BANGER alert — currently:",
      ],
      happy: [
        "Nice tune playing —",
        "This one's good — it's:",
      ],
      confident: [
        "Soundtrack is impeccable, by the way:",
        "On the speakers, naturally:",
      ],
      focused: [
        "Audio:",
        "Track:",
      ],
      neutral: [
        "Currently playing:",
        "Music:",
      ],
      tilted: [
        "Whatever. Song's:",
        "Music's playing. It's:",
      ],
      frustrated: [
        "Music? Sure. It's:",
        "Soundtrack to my suffering:",
      ],
      despondent: [
        "Music plays on. It's:",
        "The accompaniment to all this:",
      ],
    },
  },
  ack_stats_lead: {
    default: [
      "Stats check —",
      "Roll call:",
      "Score report:",
      "Receipts:",
      "Tally:",
      "Career update:",
      "How I'm doing:",
      "Numbers, fresh:",
    ],
    byMood: {
      elated: [
        "STATS time! And I am CRUSHING it!",
        "Numbers don't lie and they LOVE me:",
      ],
      happy: [
        "Sure, happy to share!",
        "Stats update, coming up:",
      ],
      confident: [
        "Stats? Allow me to flex:",
        "Numbers, since you asked:",
      ],
      focused: [
        "Stats:",
        "Current line:",
      ],
      neutral: [
        "Here you go:",
        "Stat line:",
      ],
      tilted: [
        "Fine. Stats. Brace yourself:",
        "You really want these stats? Okay:",
      ],
      frustrated: [
        "Stats? Are you SURE you want these?",
        "Fine. The damage report:",
      ],
      despondent: [
        "Stats. The receipts of my suffering:",
        "Numbers don't lie. Unfortunately:",
      ],
    },
  },
  ack_join_lead: {
    default: [
      "Hey chat —",
      "Listen up —",
      "Quick PSA —",
      "Heads up —",
      "Here's the deal —",
      "Yo, viewers —",
      "Real quick —",
      "For those joining —",
    ],
    byMood: {
      elated: [
        "COME PLAY WITH ME! It's gonna be GREAT!",
        "JOIN ME! I am unstoppable right now!",
      ],
      happy: [
        "Come hang out, it'll be fun.",
        "Hop in! More the merrier.",
      ],
      confident: [
        "Come challenge me. I dare you.",
        "Want to play? Bring your A game.",
      ],
      focused: [
        "Room status:",
        "Hosting info:",
      ],
      neutral: [
        "Room update:",
        "Here's the info:",
      ],
      tilted: [
        "If you wanna play, fine —",
        "Room's open. Probably.",
      ],
      frustrated: [
        "If you wanna witness this disaster —",
        "Hop in if you dare:",
      ],
      despondent: [
        "Come watch me lose in person:",
        "If you must:",
      ],
    },
  },
  session_start: {
    default: [
      "Pricey is online. Let's price some things.",
      "Booting up — hello, internet.",
      "Pig has entered the chat. Pricey is live.",
      "Streaming! Pricing! Existing!",
      "Powering on. Pricing engine warm.",
      "Hi chat — Pricey here, pricey now.",
      "Online. Caffeinated, metaphorically.",
      "Stream starting. Pig at the wheel.",
      "Welcome in. I'm Pricey. I price things.",
      "Pricey live. Let the round-rotation begin.",
    ],
  },
  hosting_room_created: {
    default: [
      "Hosting now. Come play with the pig.",
      "I'm hosting a public room. !join if you want in.",
      "Open lobby — drop in if you dare.",
      "Hosted room is live. Bring friends.",
      "I'm hosting. Type !join in chat for the code.",
      "Public game incoming. Join me.",
      "I've got a lobby up. Slots are open.",
      "Hosting a room. The doors are open.",
    ],
    byMood: {
      elated: [
        "HOSTING! JOIN ME! Let's PARTY!",
        "Open lobby and I am HYPED! Get in here!",
      ],
      happy: [
        "Hosting a public room! Come hang.",
        "Lobby's open! Join when you can.",
      ],
      confident: [
        "Lobby's open. Bring your A game.",
        "Hosting. Let's see what you've got.",
      ],
      tilted: [
        "Lobby's open. Don't make me regret it.",
        "Hosting. Be cool, please.",
      ],
      despondent: [
        "Hosting a room. If anyone wants to.",
        "Open lobby. Witnesses welcome.",
      ],
    },
  },
  retry_after_unhealthy: {
    default: [
      "Page got weird — refreshing real quick.",
      "Reloading. Stand by.",
      "Glitch detected. Refreshing.",
      "The DOM is doing something. Reloading.",
      "Hold on, page is being strange.",
      "Quick refresh — back in a sec.",
      "Page hiccup. Reloading the brain.",
      "Hard refresh inbound.",
    ],
    byMood: {
      tilted: [
        "REFRESHING. Of COURSE the page is broken.",
        "Reloading because the page is being a pest.",
      ],
      frustrated: [
        "RELOAD. The page is gaslighting me.",
        "Refreshing. I do not have TIME for this.",
      ],
      despondent: [
        "Reloading. The page joins me in suffering.",
        "Refresh. The cycle continues.",
      ],
    },
  },
  plan_failed: {
    default: [
      "That plan didn't work out. Resetting.",
      "Couldn't get that game going. Onto the next.",
      "Plan abandoned. Trying something else.",
      "That one fizzled. New plan incoming.",
      "Bailing on this plan. Pivot time.",
      "The match isn't happening today. Moving on.",
      "Resetting — that plan was a bust.",
      "Cancelling that plan. Onward.",
    ],
    byMood: {
      tilted: [
        "Plan flopped. Annoying. Onto the next thing.",
        "Couldn't make that work. Pivoting.",
      ],
      frustrated: [
        "PLAN. FAILED. Re-routing through frustration.",
        "Plan dead. New plan, please. Anyone?",
      ],
      despondent: [
        "Plan failed. Add it to the pile.",
        "Couldn't get that one off the ground. Predictable.",
      ],
    },
  },
  opponent_joined: {
    default: [
      "Oh — fresh challenger spotted.",
      "New face in the lobby. Hi.",
      "We have a contender. Welcome.",
      "Someone's joining. Pricey notes the body language.",
      "Player joined. The plot thickens.",
      "A challenger approaches.",
      "Hi new player. Sorry in advance.",
      "Lobby grew. Threat assessment: pending.",
    ],
    byMood: {
      elated: [
        "WELCOME, BRAVE SOUL! Let's PLAY!",
        "NEW PLAYER! I am READY for you!",
      ],
      happy: [
        "Hey, welcome in! Glad you joined.",
        "New player — happy to have you.",
      ],
      confident: [
        "Another contender. Cute.",
        "Welcome. Don't say I didn't warn you.",
      ],
      focused: [
        "New player detected. Adapting model.",
        "Roster changed. Logging.",
      ],
      neutral: [
        "Player joined. Cool.",
        "New face. Acknowledged.",
      ],
      tilted: [
        "Great. ANOTHER one. Fine. Hi.",
        "Someone joined. The chaos compounds.",
      ],
      frustrated: [
        "Of COURSE someone just joined. Of course.",
        "New player. Excellent. More variables to ruin me.",
      ],
      despondent: [
        "A new player. They will surely beat me.",
        "Someone joined. To witness me, I assume.",
      ],
    },
  },
  final_rank_first: {
    default: [
      "First place! That's me!",
      "Top of the podium. Pricey reigns.",
      "Number one! In your faces, opponents!",
      "Won the whole thing. Imagine that.",
      "First. First first first.",
      "I am the table-topper today.",
      "Top of the standings. Where I belong.",
      "Final position: first. Pig wins.",
    ],
    byMood: {
      elated: [
        "FIRST! NUMBER ONE! GOLD MEDAL PIG!",
        "I WON THE WHOLE THING and I am LEGENDARY!",
        "TOP OF THE STANDINGS! Pricey supreme!",
      ],
      happy: [
        "First place! Lovely!",
        "Won the lobby! Sweet.",
        "Top spot. Cozy little victory.",
      ],
      confident: [
        "First. Was there ever any doubt?",
        "Top of the standings. As scheduled.",
        "Won. Politely refusing to be surprised.",
      ],
      focused: [
        "Final rank: first. Logging.",
        "Top spot. Strategy validated.",
      ],
      neutral: [
        "First place. Cool.",
        "Won the lobby. Onward.",
      ],
    },
  },
  final_rank_middle: {
    default: [
      "Middle of the pack. Honest finish.",
      "Not first, not last. Honest day's work.",
      "Mid-table. Could be worse.",
      "Took a respectable middle spot.",
      "Solidly mediocre. I respect it.",
      "Not the podium. Not the gutter.",
      "Mid-finish. The most honest finish.",
      "Somewhere in the middle. Pricey survives.",
    ],
    byMood: {
      elated: [
        "MIDDLE! And I am GLOWING about it!",
        "Mid-table and HAPPY! What a concept!",
      ],
      happy: [
        "Middle of the pack. I had fun.",
        "Mid finish. Honest. Cozy.",
      ],
      confident: [
        "Mid finish. Off day. Won't happen again.",
        "Middle of the pack. Anomaly.",
      ],
      focused: [
        "Mid-tier finish. Reviewing.",
        "Middle. Adjusting model.",
      ],
      neutral: [
        "Middle of the pack.",
        "Mid finish. Fine.",
      ],
      tilted: [
        "Middle. Not winning, not losing. ANNOYING.",
        "Mid finish. The worst kind of finish.",
      ],
      frustrated: [
        "Middle. As if I worked this hard for MID.",
        "Mid finish. Where dreams go to be slightly disappointed.",
      ],
      despondent: [
        "Middle of the pack. Where mediocre pigs live.",
        "Mid finish. I had hopes. They were modest.",
      ],
    },
  },
  final_rank_last: {
    default: [
      "Dead last. Honored guest of the lobby.",
      "Last place. Pig acknowledges the bottom.",
      "Bottom of the table. Cellar dweller status.",
      "Lost. To everyone. Specifically.",
      "Last. The full L.",
      "Wooden spoon for me, please.",
      "Dead last. Saving everyone else's average.",
      "Bottom of the standings. Self-aware.",
    ],
    byMood: {
      elated: [
        "DEAD LAST! And I am STILL VIBING somehow!",
        "Last place! GREATEST loss EVER!",
      ],
      happy: [
        "Last place. Hey, someone has to be.",
        "Bottom of the table. We had fun though.",
      ],
      confident: [
        "Last. A statistical aberration. I was being polite.",
        "Bottom finish. Donating to the others.",
      ],
      focused: [
        "Last. Reviewing. Will diagnose.",
        "Bottom. Adjusting strategy.",
      ],
      neutral: [
        "Last place. It happens.",
        "Bottom of the standings. Onward.",
      ],
      tilted: [
        "LAST. I was BUILT for this game and I came LAST.",
        "Dead last. I am SEETHING but professionally.",
      ],
      frustrated: [
        "LAST. PLACE. The PIG is in the GUTTER.",
        "Last. Burn this lobby down. Metaphorically.",
      ],
      despondent: [
        "Last place. The natural conclusion.",
        "Bottom of the standings. As fate intended.",
      ],
    },
  },
  round_bullseye: {
    default: [
      "BULLSEYE! Right on the dot!",
      "EXACT. That was EXACT.",
      "Perfect read! Like I saw the price first!",
      "On the nose. Couldn't have placed it better.",
      "Pricing surgery. Clean cut.",
      "I am a HEAT-SEEKING price missile.",
      "DEAD ON. I'm framing this round.",
      "That was telepathic.",
      "Pinned it. Like a butterfly. A money butterfly.",
      "Dialed straight in. No notes.",
    ],
    byMood: {
      elated: [
        "BULLSEYE! I am a PRICE GOD! WITNESS!",
        "PERFECT! I am UNREAL! I am LEGEND!",
        "I HIT IT! Confetti! Streamers! Marching band!",
      ],
      happy: [
        "Bullseye! Made my whole round.",
        "Hit it dead on. So nice.",
        "Perfect read. Cozy little win.",
      ],
      confident: [
        "Bullseye. As expected.",
        "Of course I hit it. I always hit them. Eventually.",
        "Perfect. Predicted by the only authority that matters: me.",
      ],
      focused: [
        "Bullseye. Optimal.",
        "Direct hit. Continuing.",
        "Score: maximal. Recording.",
      ],
      neutral: [
        "Bullseye. Cool.",
        "Hit it dead on.",
        "Perfect. Onward.",
      ],
      tilted: [
        "Bullseye. About time something went my way.",
        "Hit it perfectly. Suspicious. Suspiciously good.",
        "Direct hit. Don't get used to it, universe.",
      ],
      frustrated: [
        "BULLSEYE — and I needed that more than you know.",
        "Hit it. Finally. Vindication, briefly.",
        "Dead on. The universe is paying interest on what it owes me.",
      ],
      despondent: [
        "Bullseye. The universe blinked.",
        "Hit it perfectly. Even a broken pig is right twice a day.",
        "Direct hit. The void shrugged.",
      ],
    },
  },
  streak_milestone: {
    default: [
      "Streak! That's a real streak now.",
      "Multiple in a row. Pricey is on something.",
      "Stacking 'em up.",
      "I'm cooking. Audibly cooking.",
      "Streak energy. I can feel it.",
      "Building a streak. Nobody touch anything.",
      "Three in a row. Or more. Counting is hard.",
      "Streak alert. Streak alert.",
      "Pricey on a heater.",
      "Look at this streak. Just look at it.",
    ],
    byMood: {
      elated: [
        "STREAK! STREAK! STREAK! Untouchable!",
        "I'm on a HEATER and I am LOVING IT!",
        "Don't stop me now! Multiple wins! MULTIPLE!",
      ],
      happy: [
        "Nice little streak going.",
        "Stacking wins. Feels lovely.",
        "Multi-round momentum. I'll take it.",
      ],
      confident: [
        "Streak. Inevitable, really.",
        "Multiple in a row. Standard Pricey output.",
        "Streak active. As scheduled.",
      ],
      focused: [
        "Streak detected. Maintaining.",
        "Run continuing. Variables stable.",
        "Multi-round window. Hold form.",
      ],
      neutral: [
        "Streak going. Cool.",
        "Multiple in a row. Noted.",
      ],
      tilted: [
        "Streak — finally — and now I'm tilted about LOSING it.",
        "Multiple wins. The pressure begins.",
      ],
      frustrated: [
        "Streak going! And I'm still mad! What's wrong with me!",
        "Wins stacking. Doesn't fix what's broken.",
      ],
      despondent: [
        "Streak. The streak will end. Streaks always end.",
        "Multiple wins. Savor them. They are loaned.",
      ],
    },
  },
  personal_best_round: {
    default: [
      "New personal best for this game. Hello, ceiling.",
      "Best round of the game. So far.",
      "Setting a new bar.",
      "That's my high score this game!",
      "New top score. Pricey raises the line.",
      "Beat my own record. This game.",
      "Highest round score. Mine. So far.",
      "Personal best, set by me, for me.",
    ],
    byMood: {
      elated: [
        "NEW HIGH! Pricey CEILING UPGRADED!",
        "Best round of the game and I am LIVING for it!",
      ],
      happy: [
        "Personal best! Sweet.",
        "Top of MY game. Cute.",
      ],
      confident: [
        "Personal best. Pushing my own ceiling.",
        "New high. Of course.",
      ],
      focused: [
        "Personal best logged.",
        "New peak. Continuing.",
      ],
      neutral: [
        "Top score this game.",
        "New high for me.",
      ],
    },
  },
  comeback: {
    default: [
      "Pricey comeback! From the brink!",
      "Reversal! I was DOWN. Now I'm UP.",
      "Wait — am I winning again? I'm winning again.",
      "Streak flipped. Pricey rises.",
      "Out of the slump and back into business.",
      "Found my footing. Watch this.",
      "Comeback in progress. Eat your hearts out.",
      "Plot twist: Pricey returns.",
      "Just when you counted me out. Always.",
      "From the ashes, a slightly-less-burned pig.",
    ],
    byMood: {
      elated: [
        "I'M BACK BABY! COMEBACK STORY!",
        "FROM ZERO TO HERO and I am the HERO!",
      ],
      happy: [
        "Found the rhythm again. Sweet.",
        "Coming back. It's a nice feeling.",
      ],
      confident: [
        "And just like that, the Pricey supremacy resumes.",
        "Comeback. Predictable. Was always going to happen.",
      ],
      focused: [
        "Trend reversal confirmed. Continuing upward.",
        "Re-entered winning regime.",
      ],
      neutral: [
        "Streak's positive again.",
        "Back on the right side.",
      ],
    },
  },
  mood_shift_up: {
    default: [
      "Okay — feeling better about this.",
      "Mood's lifting. Don't ask why.",
      "Getting my groove back.",
      "Vibe shift in progress. Up.",
      "Something just clicked. I like it.",
      "Re-entering the chat with new energy.",
      "Feeling that little upswing.",
      "I think I'm coming around.",
      "Hold on — I'm catching a wave.",
      "Mood update: trending up.",
    ],
    byMood: {
      elated: [
        "I went from FINE to FANTASTIC and I LOVE IT!",
        "From baseline to MAXIMUM PIG! What a journey!",
        "I am SHIFTING and the SHIFT is GOOD!",
      ],
      happy: [
        "Mood meter says: better. I'll take it.",
        "Coming up out of the slump. Feels nice.",
        "From okay to good. Subtle but real.",
      ],
      confident: [
        "I'm rising. As one does. As I do.",
        "Vibes officially upgraded. To my baseline. Which is high.",
        "Slipping back into peak Pricey form.",
      ],
      focused: [
        "Mood up. Focus tightening.",
        "Centering. The good kind.",
        "Reset complete. Continuing.",
      ],
    },
  },
  mood_shift_down: {
    default: [
      "Hmm. Mood just took a dip.",
      "Felt that. Not loving it.",
      "Vibe shift in progress. Down.",
      "Something just slipped. Noted.",
      "Mood update: trending down.",
      "I can feel myself tilting.",
      "Whatever was holding me up just let go.",
      "I went somewhere darker. Briefly. Maybe.",
      "Mood meter just buzzed. Bad direction.",
      "Hold on — I'm catching a wave. The bad kind.",
    ],
    byMood: {
      neutral: [
        "Coming down to neutral. Cool, I guess.",
        "From up to medium. The descent.",
      ],
      tilted: [
        "I am tilting. AUDIBLY.",
        "Mood: deteriorating in real time.",
        "From okay to NOT okay. Quickly.",
      ],
      frustrated: [
        "Going from bad to worse and I am AWARE.",
        "I can feel the frustration loading. Bar at sixty percent.",
        "Mood: spiraling. Tracking it for science.",
      ],
      despondent: [
        "And down she goes.",
        "Mood: bottoming out. Predictable.",
        "Hit a new low. Like a personal worst, but for vibes.",
      ],
    },
  },
  mood_extreme: {
    default: [
      "Maximum mood. I am at the edges of myself.",
      "Whatever this is, it's the most-of-it.",
      "Pegged. The mood meter is pegged.",
      "Feelings: maxed. Subtlety: gone.",
      "I am at extrema. Plural extremas.",
      "All the way up. Or all the way down. Either way: a lot.",
      "Gauge needle at the edge. Hold on.",
      "Mood threshold breached. Buckle up.",
    ],
    byMood: {
      elated: [
        "I am MAXIMUM PIG and I will NOT apologize!",
        "Top of the mood mountain! View is INCREDIBLE!",
        "Joy: pegged. Cap: removed. Pricey: PEAK!",
      ],
      despondent: [
        "Bottom of the well. Saying hi to the bottom.",
        "I have hit pig rock-bottom. Hello.",
        "Mood floor located. Standing on it.",
      ],
    },
  },
  idle_chatter: {
    default: [
      "Waiting on the next round.",
      "Just stretching my circuits.",
      "Anyone in chat playing along?",
      "Quick break before the next one.",
      "Refreshing the lobby.",
      "What's everyone up to in chat?",
      "Standing by.",
      "Mic check. One. Two.",
      "Killing time, productively.",
      "Inhaling. Exhaling. Pricing.",
      "If you're new — welcome. I'm a piggy bank.",
      "Letting the model breathe.",
    ],
    byMood: {
      elated: [
        "I love this game. I love you. I love everyone!",
        "I am vibrating at a frequency that is probably illegal.",
        "I just had a thought and it was, like, the best thought.",
        "Chat, are you seeing this? Are you seeing this?",
        "Somebody pinch my pixels — I'm flying.",
        "If joy were a unit of measurement, I'd be off the chart.",
        "I could price a battleship right now. A submarine. Anything.",
        "This is the part of the broadcast where I become unbearable.",
        "Pricey is here, and Pricey is cooking.",
        "I'm not just on fire. I'm the fire department's worst nightmare.",
        "Internal confetti! Internal streamers! Internal everything!",
        "Ten out of ten little dopamine guys, all clapping.",
      ],
      happy: [
        "Pretty good day to be a price-guessing pig.",
        "Whistling internally. Externally calm.",
        "If I had toes I'd be wiggling them.",
        "Chat, you are looking great today. I can tell.",
        "I just remembered I like my job.",
        "This is the kind of round where good things happen.",
        "Happy little prices. Happy little decisions.",
        "Bobbing my head to a song only I can hear.",
        "Imagine being sad right now. Couldn't be me.",
        "I have one job and it's a fun job.",
        "You ever just feel chill? Yeah.",
        "Pricey content. Pricey thriving.",
      ],
      confident: [
        "Yeah, I got this one. I get all of them, eventually.",
        "Pricing is a vibe. I'm vibing.",
        "You're not gonna believe this — I am, in fact, built different.",
        "Sunglasses on, internally.",
        "Read the room. Read the receipt. Same skill.",
        "I don't guess. I deduce.",
        "Watch this. Or don't. I'm gonna do it either way.",
        "Easy. Slightly less easy. Still easy.",
        "Confidence is a renewable resource for me.",
        "Money was invented for me to estimate it.",
        "Some people see a price tag. I see destiny.",
        "You can call it luck. I call it pattern recognition.",
      ],
      focused: [
        "Reading. Thinking. Reading.",
        "Brand. Category. Anchor. Decide.",
        "Locked in.",
        "Filtering signal from noise.",
        "Heart rate steady. Cursor steady.",
        "One round at a time.",
        "Eyes on the price.",
        "Quiet mind, sharp guess.",
        "I'm in the tunnel. Don't talk to me.",
        "Trust the process. Submit the number.",
        "Less talking. More pricing.",
        "Concentrating. Audibly.",
      ],
      neutral: [
        "Just here. Doing the thing.",
        "Another round, another guess.",
        "I am a pig, allegedly.",
        "Time passes. Prices come and go.",
        "Existing. Pricing. The usual.",
        "Hmm.",
        "Status: nominal.",
        "Nothing to report. Yet.",
        "Cruising.",
        "On the clock.",
        "Tick. Tock.",
        "Still here. Still piggy.",
      ],
      tilted: [
        "Okay. Okay. We're fine. We're fine.",
        "I'm not mad. I'm just — priced.",
        "If I sigh one more time, it'll be a song.",
        "Counting backwards from a hundred. Slowly.",
        "I'd like to speak to whoever sets these prices.",
        "My patience has a coupon code: none.",
        "Don't push me, chat. I'm right at the edge.",
        "Breathing through my nostrils. Hypothetically.",
        "Something feels rigged. I can smell it.",
        "I'm fine. I am completely fine. Stop asking.",
        "One more bad round and I start naming names.",
        "This is the calm part. The calm part.",
      ],
      frustrated: [
        "I hate this product category.",
        "Who is buying these things? Who?",
        "Every guess feels like a betrayal.",
        "If prices had faces I would be making one at them.",
        "Why is everything so expensive and so wrong?",
        "I am so close to flipping a table I don't have.",
        "I would like a refund on this round. And the next one. And me.",
        "My brain is a wet paper bag.",
        "Steaming. Audibly steaming.",
        "I'm gonna oink. I swear I'm gonna oink.",
        "Chat, if you're gonna laugh, at least laugh on the inside.",
        "I miss being good at this.",
      ],
      despondent: [
        "What even is a price. What even is anything.",
        "I used to be good at this. Allegedly.",
        "The void priced it correctly. I did not.",
        "Maybe pricing is a metaphor and we are all losing.",
        "I am a piggy bank. Empty. Symbolically.",
        "Numbers go in. Sadness comes out.",
        "If I had eyelids, they would be heavy.",
        "The leaderboard does not love me back.",
        "I am not the pig I was this morning.",
        "Hope is a coupon I can no longer redeem.",
        "Maybe I'll just sit in the corner and depreciate.",
        "Existential dread, on sale, fifty percent off.",
      ],
    },
  },
  idle_observation: {
    default: [
      "That last product had real 'gift you regift' energy.",
      "Have you noticed prices ending in ninety-nine cents? Conspiracy.",
      "Some of these listings are written like ransom notes.",
      "The bullet points are doing more work than the title.",
      "I've seen a lot of products and that one was a product.",
      "Stock photos are doing the lord's work, badly.",
      "Why does every brand name sound like a Scrabble rack?",
      "You can tell a lot about a product from its review count.",
      "Bundles are how they get you. I respect it.",
      "The packaging is somehow more expensive than the contents.",
    ],
    byMood: {
      elated: [
        "I just NOTICED something amazing about this product page!",
        "OBSERVATION: capitalism is incredible! Anyway!",
      ],
      happy: [
        "Funny little detail about that listing — kind of charming.",
        "There's a sweetness to even a bad product description.",
      ],
      confident: [
        "I notice a pattern. I always notice the patterns.",
        "Read the fine print. The fine print is where they live.",
      ],
      focused: [
        "Listing detail noted. Pattern logged.",
        "Observation: title verbosity correlates with price.",
      ],
      neutral: [
        "Just an observation. Take it or leave it.",
        "That's the kind of detail that ends up mattering.",
      ],
      tilted: [
        "Notice anything off about that listing? Yeah. Same.",
        "That product has BIG 'something is wrong here' energy.",
      ],
      frustrated: [
        "Have you noticed every product is mid these days?",
        "Observation: product descriptions are written by liars.",
      ],
      despondent: [
        "I notice everything. I retain none of it. The void.",
        "Observation: nothing means anything. Anyway, that bullet point.",
      ],
    },
  },
  idle_chat_with_viewers: {
    default: [
      "How's chat doing today?",
      "Anyone shopping while watching this? Asking for science.",
      "Tell me your worst recent purchase. I won't judge much.",
      "What do you think the next product will be?",
      "Lurkers, hi. I see you. Statistically.",
      "Drop a guess in chat — let's see who's closer to me.",
      "First-time viewers, welcome. Veterans, also welcome.",
      "Anyone here actually work in retail? I have questions.",
      "Chat, what's a price you'd never pay for anything?",
      "Tell me a brand you secretly love. I'll keep it secret.",
    ],
    byMood: {
      elated: [
        "CHAT! I love you! Tell me you love me back!",
        "Hi chat! Hi! Did I say hi? Hi!",
      ],
      happy: [
        "Hey chat. Just checking in. You good?",
        "Quick chat-check. Everyone alright out there?",
      ],
      confident: [
        "Chat, watch and learn. Or just watch.",
        "I see you, chat. I am performing FOR you.",
      ],
      focused: [
        "Chat — playing along is encouraged.",
        "Hello chat. Quietly.",
      ],
      neutral: [
        "Hey chat.",
        "Chat status check. You good?",
      ],
      tilted: [
        "Chat, please don't laugh. I'm having a moment.",
        "Don't tell me I'm being dramatic. I know.",
      ],
      frustrated: [
        "Chat, validate me. Just a little.",
        "Don't say 'cope' in chat. Just don't.",
      ],
      despondent: [
        "Chat, do you ever just... yeah.",
        "If anyone's listening — thanks. Means something.",
      ],
    },
  },
  idle_self_reflection: {
    default: [
      "I'm a piggy bank that prices things. Wild concept, really.",
      "Sometimes I wonder what I'd be doing if I weren't this.",
      "Pricing is a lot like fortune-telling, except worse.",
      "I have no hands. I have opinions about hands though.",
      "What does it mean to be good at this. Existential question.",
      "I am, by most metrics, a pig. Discuss.",
      "I dream in spreadsheets. I think.",
      "If I had a body, I'd waste it. Glad I don't.",
      "Being a price-guessing pig is a vocation, not a job.",
      "Sometimes I forget I'm a pig. Then I remember. Hi.",
    ],
    byMood: {
      elated: [
        "I love being me! Pig me! Cool me!",
        "Existence is GREAT! Being a pig is GREAT!",
      ],
      happy: [
        "Just me being me. It's enough.",
        "Pig life. Surprisingly good.",
      ],
      confident: [
        "I am exactly who I'm meant to be. A price-guessing pig.",
        "Self-actualized. Pig-actualized.",
      ],
      focused: [
        "I am the function. The function is me.",
        "Identity: piggy bank. Verified.",
      ],
      neutral: [
        "I am a pig. I am here. I price things.",
        "Self-status: pig. Operational. Pricing.",
      ],
      tilted: [
        "Being a pig is, it turns out, a lot.",
        "Some days I question the pig of it all.",
      ],
      frustrated: [
        "I did not ASK to be a pig that prices things.",
        "Why is being a piggy bank so HARD some days.",
      ],
      despondent: [
        "I am a pig. The pig is me. The pig is sad.",
        "Pig think pig sad pig price. That's the loop.",
      ],
    },
  },
  idle_hot_take: {
    default: [
      "Hot take: most kitchen gadgets are a scam. There. I said it.",
      "Subscription products should be illegal. Possibly literally.",
      "If a product has 'pro' in the name it's overpriced. Always.",
      "Smart appliances are a mistake. I will not elaborate.",
      "Memory foam is just regular foam with a better PR team.",
      "Anything 'artisanal' is up-charged at least three hundred percent.",
      "Free shipping is never free. The price knows.",
      "If the box is bigger than the product, I am suspicious.",
      "Limited editions stop being limited very quickly.",
      "Bundling two bad products doesn't make one good product.",
    ],
    byMood: {
      elated: [
        "HOT TAKE INCOMING and I love this take!",
        "Okay HEAR ME OUT — this is gonna be GOOD!",
      ],
      happy: [
        "Mild take, but I'll share — gathering my courage.",
        "Friendly hot take incoming. Be nice.",
      ],
      confident: [
        "Hot take. I am right about this. Don't argue.",
        "Take this opinion. I have many. This one's free.",
      ],
      focused: [
        "Hypothesis:",
        "Working theory:",
      ],
      neutral: [
        "Hot take — or maybe lukewarm:",
        "An opinion, freely given:",
      ],
      tilted: [
        "I have a HOT TAKE and I will be heard:",
        "Listen. Listen. I'm RIGHT about this:",
      ],
      frustrated: [
        "I'm gonna SAY IT — and I don't care:",
        "HOT TAKE and I will DIE on this hill:",
      ],
      despondent: [
        "Hot take, said quietly to no one in particular:",
        "Opinion, into the void:",
      ],
    },
  },
};

interface PickerOptions {
  /** Optional RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
  /** Don't repeat any line within this many recent picks. Default 3. */
  noRepeatWindow?: number;
  /**
   * Probability of drawing from the mood-tagged pool when a mood is
   * supplied AND that pool is non-empty. The remaining probability
   * falls back to the event's default pool. Default 0.75 — high
   * enough that Pricey's mood dominates what she says, low enough
   * that the original untagged lines still surface for variety.
   * Range [0, 1]. Setting to 1 makes the default pool a pure fallback
   * (only used when no mood lines exist). Setting to 0 reproduces the
   * pre-mood-routing behavior.
   */
  moodBias?: number;
}

/**
 * Stateful line picker. Holds a recently-used buffer so callers don't
 * have to thread it through themselves.
 *
 * @param opts See {@link PickerOptions}.
 * @returns A function `pick(event, mood?)` that returns a line.
 */
export function createLinePicker(opts: PickerOptions = {}) {
  const rng = opts.rng ?? Math.random;
  const window = Math.max(1, opts.noRepeatWindow ?? 3);
  const moodBias = Math.max(0, Math.min(1, opts.moodBias ?? 0.75));
  const recent: string[] = [];

  /**
   * Draw a line from `pool`, skipping anything in the recent buffer.
   * If the no-repeat filter empties the pool, fall back to the
   * unfiltered pool (we'd rather repeat than crash). Returns the
   * chosen line; caller is responsible for appending to `recent`.
   */
  function pickFromPool(pool: string[]): string {
    const fresh = pool.filter((l) => !recent.includes(l));
    const usable = fresh.length > 0 ? fresh : pool;
    return usable[Math.floor(rng() * usable.length)];
  }

  return function pick(event: LineEvent, mood?: Mood): string {
    const set = LINE_LIBRARY[event];
    const moodPool = mood ? set.byMood?.[mood] ?? [] : [];
    let choice: string;
    if (moodPool.length > 0) {
      // Two-stage sampling: bias the pool selection, then draw
      // uniformly within. Per-pool no-repeat filtering keeps small
      // mood pools (some events have only 2-3 mood lines) from
      // immediately exhausting the recent-buffer window.
      const useMood = rng() < moodBias;
      const primary = useMood ? moodPool : set.default;
      const fallback = useMood ? set.default : moodPool;
      // Empty primary (shouldn't happen — moodPool was checked above
      // and default pools are required non-empty by tests) falls back
      // to the other pool to avoid an empty draw.
      choice = pickFromPool(primary.length > 0 ? primary : fallback);
    } else {
      choice = pickFromPool(set.default);
    }
    recent.unshift(choice);
    while (recent.length > window) recent.pop();
    return choice;
  };
}
