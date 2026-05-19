import { memo } from "react";
import { SparklesIcon } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";

export const SkillInlineChip = memo(function SkillInlineChip(props: { name: string }) {
  return (
    <span className={COMPOSER_INLINE_CHIP_CLASS_NAME} aria-label={`/${props.name}`}>
      <SparklesIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} aria-hidden="true" />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>/{props.name}</span>
    </span>
  );
});
