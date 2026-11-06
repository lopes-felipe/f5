import type { Project } from "../../types";
import { ProjectPicker } from "../ProjectPicker";
import type { HomeProjectSelection } from "./HomeProjectPickerPlaceholder";

/** Home's searchable project picker. It loads after the first paint to keep startup small. */
export default function HomeProjectPicker(props: {
  readonly projects: ReadonlyArray<Project>;
  readonly selection: HomeProjectSelection | null;
  readonly onSelect: (selection: HomeProjectSelection) => void;
}) {
  return (
    <ProjectPicker
      projects={props.projects}
      selection={props.selection}
      onSelect={props.onSelect}
      allowNone
      trigger="home"
    />
  );
}
