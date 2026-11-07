// Renders a Lucide icon by its kebab-case name (as used in app specs).
import { icons, type LucideIcon, type LucideProps } from "lucide-solid";
import tags from "lucide-static/tags.json";
import { Show, splitProps, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

const registry = icons as unknown as Record<string, LucideIcon>;

const toPascal = (name: string) =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

export const iconFor = (name: string | null | undefined): LucideIcon | undefined =>
  name ? registry[toPascal(name)] : undefined;

/** Every icon name (kebab-case) with its search tags. */
export const iconTags = tags as Record<string, string[]>;

export function Icon(props: LucideProps & { name: string | null | undefined; fallback?: JSX.Element }) {
  const [local, rest] = splitProps(props, ["name", "fallback"]);
  return (
    <Show when={iconFor(local.name)} fallback={local.fallback}>
      {(component) => <Dynamic component={component()} size={16} {...rest} />}
    </Show>
  );
}
