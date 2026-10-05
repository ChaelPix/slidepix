from manim import *


class IntroStill(Scene):
    def construct(self):
        title = Text("Manim in SlidePix", font_size=56)
        subtitle = Text("Linked .py, embedded render", font_size=30, color=BLUE)
        subtitle.next_to(title, DOWN, buff=0.4)
        self.add(title, subtitle)


class MotionClip(Scene):
    def construct(self):
        circle = Circle(radius=1.4, color=YELLOW, fill_opacity=0.35, stroke_width=6)
        label = Text("Animate me", font_size=42)
        self.play(Create(circle), Write(label))
        self.play(Rotate(circle, angle=TAU), run_time=2)
        self.wait(0.3)
