import type { SVGProps } from "react";

// Sigma T3 mark. Kept under the upstream name so imports merge cleanly.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="32 26 64 76" xmlns="http://www.w3.org/2000/svg">
      <path d="M32 26H96V42H56L78 64L56 86H96V102H32V88L54 64L32 40Z" fill="currentColor" />
    </svg>
  );
}
