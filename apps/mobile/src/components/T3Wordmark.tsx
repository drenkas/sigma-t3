import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

// Sigma T3 mark. Kept under the upstream name so imports merge cleanly.
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 64 / 76;
  return (
    <Svg
      accessibilityLabel="Sigma"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="32 26 64 76"
    >
      <ThemedPath
        d="M32 26H96V42H56L78 64L56 86H96V102H32V88L54 64L32 40Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
