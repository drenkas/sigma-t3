// @effect-diagnostics nodeBuiltinImport:off - Path containment is pure string logic, needed outside an Effect context.
import * as NodePath from "node:path";

const contains = (root: string, path: string) => {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

/** True when two canonical paths are the same or one lies inside the other, on any platform. */
export const pathsOverlap = (left: string, right: string) =>
  contains(left, right) || contains(right, left);
