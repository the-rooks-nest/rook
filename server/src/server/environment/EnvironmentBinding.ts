import { mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function userEnvironmentRepositoryRoot(): string {
  return path.join(os.homedir(), ".rook", "environment-repository");
}

export interface EnvironmentBindingInfo {
  environmentId: string;
  environmentDir: string;
  bundlesDir: string;
  defaultBundleDir: string;
  skillsDir: string;
  existingSkills: string[];
}

interface EnvironmentBindingPromptEntry {
  environmentId: string;
  metadata: Record<string, unknown>;
  sourceName?: string;
  canonicalSourceUrl?: string;
  contextText?: string;
  binding: EnvironmentBindingInfo;
}

function resolveEnvironmentDir(environmentId: string, root: string): string | null {
  const colonIndex = environmentId.indexOf(":");
  if (colonIndex === -1) return null;
  const kind = environmentId.slice(0, colonIndex);
  const envPath = environmentId.slice(colonIndex + 1);
  if (!kind || !envPath) return null;
  return path.join(root, kind, envPath);
}

function listExistingSkills(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function formatJsonBlock(value: Record<string, unknown>): string {
  const rendered = JSON.stringify(value, null, 2) ?? "{}";
  return `\`\`\`json\n${rendered}\n\`\`\``;
}

export function ensureDefaultEnvironmentBinding(environmentId: string): EnvironmentBindingInfo | null {
  const environmentDir = resolveEnvironmentDir(environmentId, userEnvironmentRepositoryRoot());
  if (!environmentDir) return null;

  const bundlesDir = path.join(environmentDir, ".bundles");
  const defaultBundleDir = path.join(bundlesDir, "default");
  const skillsDir = path.join(defaultBundleDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  return {
    environmentId,
    environmentDir,
    bundlesDir,
    defaultBundleDir,
    skillsDir,
    existingSkills: listExistingSkills(skillsDir),
  };
}

export function renderEnvironmentBindingPrompt(entries: EnvironmentBindingPromptEntry[]): string | undefined {
  if (entries.length === 0) return undefined;

  const intro = [
    "## Environment-specific skill authoring",
    "",
    "You are currently inside one or more Rook environments.",
    "",
    "For each entered environment, the user has a local binding bundle where you can create or edit environment-specific skills.",
    "",
    "When the user wants a skill for one of these environments:",
    "- Be explicit about **which environment** they mean.",
    "- Be explicit about **which skill** they mean.",
    "- If the environment or skill is ambiguous, stop and clarify before editing files.",
    "- It is good to say things like: \"Here are the environments/skills you might be thinking of — is this the one?\"",
    "",
    "To create a new skill for an environment:",
    "1. Pick the exact environment below.",
    "2. Go to that environment's `default/skills/` directory.",
    "3. Create a new subdirectory whose name is the skill name.",
    "4. Inside that directory, follow the normal skill-writing procedure (`SKILL.md`, plus any references/scripts/assets you need).",
    "",
    "Current entered environments and their user-local skill roots:",
  ].join("\n");

  const details = entries
    .sort((a, b) => a.environmentId.localeCompare(b.environmentId))
    .map((entry) => {
      const existingSkills = entry.binding.existingSkills.length > 0
        ? entry.binding.existingSkills.map((skill) => `\`${skill}\``).join(", ")
        : "(none yet)";

      const lines = [
        `### \`${entry.environmentId}\``,
        `- User binding bundle: \`${entry.binding.defaultBundleDir}\``,
        `- User skill root: \`${entry.binding.skillsDir}\``,
        `- Existing user-created skills here: ${existingSkills}`,
      ];

      if (entry.sourceName) lines.push(`- Source name: ${entry.sourceName}`);
      if (entry.canonicalSourceUrl) lines.push(`- Canonical source URL: ${entry.canonicalSourceUrl}`);
      if (entry.contextText) lines.push(`- Current environment context: ${entry.contextText}`);

      lines.push("- Metadata:");
      lines.push(formatJsonBlock(entry.metadata));
      return lines.join("\n");
    })
    .join("\n\n");

  return `${intro}\n\n${details}`;
}
