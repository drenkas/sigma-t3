// Tabler 3.44 exports per-icon runtime modules but points their declarations at missing files.
declare module "@tabler/icons-react-native/types" {
  import type { ForwardRefExoticComponent } from "react";
  import type { SvgProps } from "react-native-svg";

  export interface IconProps extends SvgProps {
    size?: string | number;
    strokeWidth?: string | number;
    title?: string;
  }

  export type Icon = ForwardRefExoticComponent<IconProps>;
}

declare module "@tabler/icons-react-native/Icon*" {
  import type { Icon } from "@tabler/icons-react-native/types";

  const icon: Icon;
  export default icon;
}
