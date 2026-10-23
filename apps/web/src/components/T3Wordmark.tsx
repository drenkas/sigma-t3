import type { SVGProps } from "react";

// Sigma T3 mark: a sigma drawn as an agent graph. Kept under the upstream name so imports merge cleanly.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="21 17 66 90" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M78 26H30L56 62L30 98H70"
        fill="none"
        stroke="currentColor"
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M69 26A9 9 0 1 0 87 26A9 9 0 1 0 69 26ZM21 26A9 9 0 1 0 39 26A9 9 0 1 0 21 26ZM21 98A9 9 0 1 0 39 98A9 9 0 1 0 21 98ZM61 98A9 9 0 1 0 79 98A9 9 0 1 0 61 98ZM44 62A12 12 0 1 0 68 62A12 12 0 1 0 44 62Z"
        fill="currentColor"
      />
    </svg>
  );
}
