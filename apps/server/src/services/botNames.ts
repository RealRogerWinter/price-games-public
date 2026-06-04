/**
 * Bot name generator — produces silly adjective + animal combos.
 *
 * @module botNames
 */

const ADJECTIVES = [
  "Sneaky", "Jolly", "Grumpy", "Bouncy", "Fluffy", "Dizzy", "Wobbly",
  "Clever", "Speedy", "Lazy", "Fancy", "Quirky", "Zany", "Spooky",
  "Cheeky", "Crafty", "Mighty", "Peppy", "Sassy", "Wacky", "Goofy",
  "Rowdy", "Bubbly", "Cranky", "Zippy", "Perky", "Nutty", "Feisty",
  "Giggly", "Snappy", "Plucky", "Frisky", "Witty", "Daring", "Pudgy",
  "Sly", "Bold", "Tiny", "Hasty", "Cocky",
] as const;

const ANIMALS = [
  "Pangolin", "Capybara", "Platypus", "Axolotl", "Quokka", "Narwhal",
  "Lemur", "Alpaca", "Wombat", "Ocelot", "Toucan", "Gecko", "Puffin",
  "Ferret", "Otter", "Badger", "Moose", "Sloth", "Iguana", "Parrot",
  "Walrus", "Beaver", "Pelican", "Marmot", "Chinchilla", "Flamingo",
  "Hedgehog", "Mantis", "Newt", "Armadillo", "Chameleon", "Stingray",
  "Lobster", "Penguin", "Coyote", "Seahorse", "Panda", "Falcon",
  "Llama", "Dingo",
] as const;

/**
 * Generate a single unique bot name not already in the existing set.
 *
 * @param existingNames - Names to avoid collisions with
 * @returns A unique "Adjective Animal" name
 */
export function generateBotName(existingNames: Set<string>): string {
  const maxAttempts = 200;
  for (let i = 0; i < maxAttempts; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const name = `${adj} ${animal}`;
    if (!existingNames.has(name)) return name;
  }
  // Fallback: numbered name for when the pool is exhausted
  let counter = 1;
  while (existingNames.has(`Bot ${counter}`)) counter++;
  return `Bot ${counter}`;
}

/**
 * Generate multiple unique bot names.
 *
 * @param count - Number of names to generate
 * @param existingNames - Names to avoid collisions with
 * @returns Array of unique names
 */
export function generateBotNames(count: number, existingNames: Set<string>): string[] {
  const names: string[] = [];
  const combined = new Set(existingNames);
  for (let i = 0; i < count; i++) {
    const name = generateBotName(combined);
    names.push(name);
    combined.add(name);
  }
  return names;
}
