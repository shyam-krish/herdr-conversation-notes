"""Word wrapping for the display, without inserting newlines into the note."""
from __future__ import annotations

import re
from functools import lru_cache

from prompt_toolkit.layout.processors import Processor, Transformation, TransformationInput
from prompt_toolkit.layout.screen import Char
from prompt_toolkit.layout.utils import explode_text_fragments


@lru_cache(maxsize=4096)
def cell_width(char: str) -> int:
    # Match the renderer, including wide/combining Unicode and visible controls.
    return Char(char).width


class WordWrapProcessor(Processor):
    def apply_transformation(self, ti: TransformationInput) -> Transformation:
        width = ti.width  # Window already deducted the scrollbar/margins.
        if width <= 0 or any("[ZeroWidthEscape]" in f[0] for f in ti.fragments):
            return Transformation(ti.fragments)
        chars = explode_text_fragments(ti.fragments)
        text = "".join(fragment[1] for fragment in chars)
        words = {match.start(): sum(cell_width(c) for c in match.group())
                 for match in re.finditer(r"\S+", text)}
        fragments = []
        to_display = []
        to_source = []
        column = 0
        seen_word = False

        for index, fragment in enumerate(chars):
            char = fragment[1]
            word_width = words.get(index, 0)
            if 0 < column < width and word_width <= width and column + word_width > width:
                # Fill the rest of the display row so Window starts this word
                # on the next row. These spaces never enter the text buffer.
                padding = width - column
                fragments.append(("", " " * padding))
                to_source.extend([max(0, index - 1)] * padding)
                column = width
            to_display.append(len(to_source))
            if char.isspace() and column == width and seen_word:
                # A separator after an exactly full row must not create an
                # empty row before the next word. Preserve it in the buffer.
                continue
            fragments.append(fragment)
            to_source.append(index)
            size = cell_width(char)
            if column + size > width:
                column = 0
            column += size
            seen_word = seen_word or not char.isspace()

        to_display.append(len(to_source))
        to_source.append(len(chars))
        return Transformation(
            fragments,
            source_to_display=lambda i: to_display[min(max(i, 0), len(to_display) - 1)],
            display_to_source=lambda i: to_source[min(max(i, 0), len(to_source) - 1)],
        )
