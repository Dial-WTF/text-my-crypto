import { LOGO_PATHS, type LogoId } from "./logoPaths";

/** A single-colour brand mark that inherits the current text colour, so every theme recolours it. */
export function Logo({ id, title }: { id: LogoId; title: string }) {
  return (
    <svg viewBox={LOGO_PATHS[id].viewBox} role="img" aria-label={title} width="1em" height="1em" fill="currentColor">
      <path d={LOGO_PATHS[id].d} />
    </svg>
  );
}
