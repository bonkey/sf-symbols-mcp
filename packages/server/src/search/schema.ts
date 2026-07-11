import { z } from "zod";

/**
 * Tool input schemas. The optional structured fields of search_sf_symbols are
 * the query-decomposition trick: their descriptions instruct the CALLING LLM
 * to decompose the request, so decomposition happens at the caller's
 * inference time — the server never needs an LLM.
 */

export const PlatformsInputSchema = z
  .object({
    iOS: z.string().optional(),
    macOS: z.string().optional(),
    tvOS: z.string().optional(),
    watchOS: z.string().optional(),
    visionOS: z.string().optional(),
  })
  .describe(
    'Minimum OS versions your app supports, e.g. {"iOS":"16.0"}. Symbols introduced later are excluded.',
  );

export const searchInputShape = {
  query: z
    .string()
    .min(1)
    .describe(
      "Natural-language description of the icon's UI function, e.g. 'button to download the invoice'.",
    ),
  primaryAction: z
    .string()
    .optional()
    .describe(
      "The single most important verb the icon must communicate (e.g. 'download', 'share', 'delete'). If the query implies an action, ALWAYS extract it here — it is the strongest ranking signal.",
    ),
  object: z
    .string()
    .optional()
    .describe(
      "The thing depicted or acted upon (e.g. 'document', 'photo', 'message'). Omit for pure action glyphs.",
    ),
  destination: z
    .string()
    .optional()
    .describe(
      "Where the action moves something to/from, if any (e.g. 'cloud', 'trash', 'folder')."),
  state: z
    .enum([
      "default",
      "selected",
      "active",
      "disabled",
      "off",
      "muted",
      "error",
      "warning",
      "new",
      "in-progress",
      "locked",
    ])
    .optional()
    .describe(
      "UI state the icon represents. off/disabled/muted map to slash variants; selected maps to filled variants in iOS tab bars; new maps to badge variants.",
    ),
  direction: z
    .enum([
      "up",
      "down",
      "left",
      "right",
      "forward",
      "backward",
      "clockwise",
      "counterclockwise",
    ])
    .optional()
    .describe(
      "Required direction of any arrow/chevron/motion. Set whenever direction matters — mismatches are heavily penalized.",
    ),
  uiContext: z
    .enum([
      "tabBar",
      "toolbar",
      "navigationBar",
      "button",
      "contextMenu",
      "list",
      "statusIndicator",
      "badge",
      "widget",
      "onboarding",
      "emptyState",
    ])
    .optional()
    .describe("Where the icon will be used; affects variant choice and ranking."),
  preferredMetaphors: z
    .array(z.string())
    .optional()
    .describe(
      "Visual metaphors you'd like, in symbol vocabulary (e.g. ['tray','arrow.down']). Boosts candidates containing them.",
    ),
  excludedMetaphors: z
    .array(z.string())
    .optional()
    .describe(
      "Visual metaphors to avoid (e.g. ['cloud'] if the app has no cloud service). Penalized, with a warning when a result still contains one.",
    ),
  platforms: PlatformsInputSchema.optional(),
  includeRestricted: z
    .boolean()
    .optional()
    .describe(
      "Include Apple-restricted symbols (usable only to refer to specific Apple products). Default false; restricted symbols still appear when the query names the product.",
    ),
  limit: z.number().int().min(1).max(25).optional().describe("Max families to return (default 8)."),
  includeVariants: z
    .boolean()
    .optional()
    .describe("Attach each family's variant list (default true)."),
  explain: z
    .boolean()
    .optional()
    .describe("Include the per-result score breakdown (default false)."),
} as const;

export const SearchInputSchema = z.object(searchInputShape);
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const getInfoInputShape = {
  name: z
    .string()
    .min(1)
    .describe("Exact SF Symbol name (old names and UIKit semantic names are resolved)."),
} as const;

export const resolveVariantInputShape = {
  base: z
    .string()
    .min(1)
    .describe("Any member of the symbol family, e.g. 'bell' or 'bell.badge.fill'."),
  state: z
    .object({
      filled: z.boolean().optional().describe("Filled variant (.fill)."),
      slashed: z
        .boolean()
        .optional()
        .describe("Slash variant (.slash) — off/disabled/muted semantics."),
      badge: z
        .string()
        .optional()
        .describe(
          "Badge content: 'plus', 'minus', 'checkmark', 'xmark', 'questionmark', 'exclamationmark', 'clock', or '' for a plain badge.",
        ),
      enclosure: z
        .enum(["circle", "square", "rectangle", "none"])
        .optional()
        .describe("Enclosing shape variant."),
    })
    .optional()
    .describe("Explicit variant axes; wins over semantics/uiContext rules."),
  semantics: z
    .enum(["notification", "add", "remove", "containment", "prominent"])
    .optional()
    .describe("What the variant should express; mapped by platform conventions."),
  uiContext: z
    .enum(["tabBar", "toolbar", "navigationBar", "button", "sidebar"])
    .optional(),
  selected: z
    .boolean()
    .optional()
    .describe("Whether the control is in a selected state (iOS tab bars prefer .fill)."),
  platform: z.enum(["iOS", "macOS", "tvOS", "watchOS", "visionOS"]).optional(),
  platforms: PlatformsInputSchema.optional(),
} as const;

export const ResolveVariantInputSchema = z.object(resolveVariantInputShape);
export type ResolveVariantInput = z.infer<typeof ResolveVariantInputSchema>;
