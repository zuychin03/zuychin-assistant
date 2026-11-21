// Seat angles. Pure, because the Start a council panel imports the presets.

// Different default angles so a room of similar models still disagrees.
export const DEFAULT_STANCES = [
    "Builds the strongest case for the most promising option.",
    "Stress-tests every proposal and looks for how it fails.",
    "Weighs cost, risk and what is simplest to ship.",
    "Looks for options nobody has raised yet.",
    "Checks claims against evidence and names what is unknown.",
] as const;

/** Ready-made angles for the Angle field; the first five are the defaults above. */
export const PRESET_ANGLES: readonly { label: string; text: string }[] = [
    { label: "Champion", text: DEFAULT_STANCES[0] },
    { label: "Stress tester", text: DEFAULT_STANCES[1] },
    { label: "Pragmatist", text: DEFAULT_STANCES[2] },
    { label: "Explorer", text: DEFAULT_STANCES[3] },
    { label: "Evidence checker", text: DEFAULT_STANCES[4] },
    { label: "Sceptic", text: "Assumes the proposal will fail and looks for why, starting with its weakest assumption." },
    { label: "Security reviewer", text: "Looks for how each option could leak data, be abused or fail unsafely, and what it would take to prevent that." },
    { label: "Cost reviewer", text: "Counts what each option really costs in money, time and upkeep, including free tiers that run out." },
    { label: "User's advocate", text: "Argues for the person who lives with the result every day: clarity, effort and what would annoy them." },
];
