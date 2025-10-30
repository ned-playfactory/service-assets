const TRADEMARK_REPLACEMENTS = [
  {
    terms: ["futurama"],
    replacement:
      "retro-futuristic cartoon universe with original characters, hover cars, neon cityscapes",
  },
  {
    terms: ["simpsons", "springfield"],
    replacement:
      "bright suburban cartoon style with playful original characters and pastel colors",
  },
  {
    terms: ["star wars", "lightsaber", "jedi", "sith"],
    replacement:
      "galactic space opera aesthetic featuring original heroes, glowing energy blades, and starships",
  },
  {
    terms: ["harry potter", "hogwarts"],
    replacement:
      "whimsical wizard academy theme with original young mages, floating candles, and spellbooks",
  },
  {
    terms: ["marvel", "avengers", "spider-man", "iron man", "thor"],
    replacement:
      "dynamic comic-book superhero vibe with original caped heroes and vibrant energy effects",
  },
  {
    terms: ["disney"],
    replacement:
      "storybook fantasy world with original characters, sparkling castles, and enchanted forests",
  },
  {
    terms: ["pokemon", "pokémon"],
    replacement:
      "colorful creature-training theme with original pocket monsters and elemental powers",
  },
  {
    terms: ["lego"],
    replacement:
      "modular toy brick aesthetic with original figures built from interlocking blocks",
  },
  {
    terms: ["star trek", "enterprise", "vulcan", "klingon"],
    replacement:
      "optimistic interstellar exploration setting with original crews and sleek starships",
  },
];

const GENERIC_FALLBACK =
  "original board game piece rendered in a family-friendly, copyright-safe style";

export function sanitizePrompt(input = "") {
  let prompt = input || "";
  const replacements = [];

  if (!prompt.trim()) {
    return { prompt: GENERIC_FALLBACK, replacements };
  }

  TRADEMARK_REPLACEMENTS.forEach(({ terms, replacement }) => {
    terms.forEach((term) => {
      const regex = new RegExp(`\\b${term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "gi");
      if (regex.test(prompt)) {
        prompt = prompt.replace(regex, replacement);
        replacements.push({ term, replacement });
      }
    });
  });

  if (replacements.length > 0) {
    prompt = `${prompt} (original design, no copyrighted characters or logos.)`;
  }

  const sanitized = prompt.trim() || GENERIC_FALLBACK;
  return { prompt: sanitized, replacements };
}
