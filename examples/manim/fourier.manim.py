from manim import *
import numpy as np

INK = "#111827"
BLUE_C = "#2563eb"
AMBER = "#d97706"
CORAL = "#e11d48"
MUTED = "#64748b"
AXIS = "#94a3b8"
PAPER = "#f8fafc"


def paper(scene: Scene) -> None:
    scene.camera.background_color = "#FFFFFF"


def axes(x_range, y_range, x_length, y_length) -> Axes:
    return Axes(
        x_range=x_range,
        y_range=y_range,
        x_length=x_length,
        y_length=y_length,
        tips=False,
        axis_config={"color": AXIS, "stroke_width": 2},
    )


def square_partial(n: int):
    count = max(1, int(n))

    def f(x):
        values = np.asarray(x, dtype=float)
        total = np.zeros_like(values)
        for k in range(count):
            harmonic = 2 * k + 1
            total += np.sin(harmonic * values) / harmonic
        return (4 / np.pi) * total

    return f


class HarmonicsStill(Scene):
    """Three odd harmonics and the partial sum that starts to look square."""

    def construct(self):
        paper(self)
        specs = [
            (1, 1.0, "sin(t)", BLUE_C),
            (3, 1 / 3, "sin(3t) / 3", "#7c3aed"),
            (5, 1 / 5, "sin(5t) / 5", CORAL),
        ]
        rows = VGroup()
        for harmonic, amplitude, label, color in specs:
            row_axes = axes([0, TAU, PI], [-1.4, 1.4, 1], 4.8, 1.2)
            graph = row_axes.plot(
                lambda x, h=harmonic, a=amplitude: a * np.sin(h * x),
                x_range=[0, TAU, 0.03],
                color=color,
                stroke_width=4,
            )
            caption = Text(label, font_size=22, color=color)
            caption.next_to(row_axes, UP, buff=0.08)
            rows.add(VGroup(row_axes, graph, caption))
        rows.arrange(DOWN, buff=0.28, aligned_edge=LEFT)
        rows.shift(LEFT * 3.55 + DOWN * 0.05)

        sum_axes = axes([0, TAU, PI], [-1.5, 1.5, 1], 5.2, 4.6)
        sum_axes.shift(RIGHT * 3.55 + DOWN * 0.15)
        total = sum_axes.plot(
            square_partial(3),
            x_range=[0, TAU, 0.02],
            color=BLUE_C,
            stroke_width=5,
        )
        top = Line(sum_axes.c2p(0.08, 1), sum_axes.c2p(PI - 0.08, 1), color=AMBER, stroke_width=3)
        bottom = Line(sum_axes.c2p(PI + 0.08, -1), sum_axes.c2p(TAU - 0.08, -1), color=AMBER, stroke_width=3)
        sum_label = Text("somme", font_size=24, color=INK).next_to(sum_axes, UP, buff=0.15)

        figure = VGroup(rows, sum_axes, total, top, bottom, sum_label)
        figure.scale(min(13.0 / figure.width, 6.6 / figure.height))
        figure.move_to(ORIGIN)
        self.add(figure)


class BuildSquare(Scene):
    """Odd harmonics accumulate into a square wave. The corner overshoot is Gibbs."""

    def construct(self):
        paper(self)
        plot = axes([0, TAU, PI / 2], [-1.7, 1.7, 1], 12.4, 5.4)
        plot.shift(DOWN * 0.25)
        target_top = Line(plot.c2p(0.06, 1), plot.c2p(PI - 0.06, 1), color=AMBER, stroke_width=3)
        target_bottom = Line(plot.c2p(PI + 0.06, -1), plot.c2p(TAU - 0.06, -1), color=AMBER, stroke_width=3)
        target_note = Text("carré visé", font_size=22, color=AMBER).move_to(plot.c2p(PI / 2, 1.48))

        terms = ValueTracker(1)
        graph = always_redraw(
            lambda: plot.plot(
                square_partial(round(terms.get_value())),
                x_range=[0, TAU, 0.015],
                color=BLUE_C,
                stroke_width=4.5,
            )
        )
        counter = always_redraw(
            lambda: Text(
                f"N = {int(round(terms.get_value()))}    4/π Σ sin((2k+1)t) / (2k+1)",
                font_size=26,
                color=INK,
            ).to_edge(DOWN, buff=0.28)
        )

        self.add(plot, target_top, target_bottom, target_note, graph, counter)
        self.wait(0.4)
        self.play(terms.animate.set_value(8), run_time=7, rate_func=linear)
        self.wait(0.7)


class TimeToFrequency(Scene):
    """Raising the pitch of a pure sine moves a single peak along the frequency axis."""

    def construct(self):
        paper(self)
        freq = ValueTracker(1.0)
        time_axes = axes([0, 1, 0.25], [-1.45, 1.45, 1], 6.3, 3.6)
        time_axes.shift(LEFT * 3.35 + DOWN * 0.25)
        spec_axes = axes([0, 5, 1], [0, 1.35, 1], 6.0, 3.6)
        spec_axes.shift(RIGHT * 3.35 + DOWN * 0.25)

        time_label = Text("temps  t", font_size=26, color=INK).next_to(time_axes, UP, buff=0.12)
        spec_label = Text("fréquence  ξ", font_size=26, color=INK).next_to(spec_axes, UP, buff=0.12)

        wave = always_redraw(
            lambda: time_axes.plot(
                lambda t: np.sin(2 * np.pi * freq.get_value() * t),
                x_range=[0, 1, 0.004],
                color=BLUE_C,
                stroke_width=4,
            )
        )
        peak = always_redraw(
            lambda: spec_axes.plot(
                lambda xi: np.exp(-((xi - freq.get_value()) ** 2) / 0.012),
                x_range=[0, 5, 0.02],
                color=CORAL,
                stroke_width=4,
            )
        )
        readout = always_redraw(
            lambda: Text(
                f"sin(2π · {freq.get_value():.1f} · t)",
                font_size=30,
                color=BLUE_C,
            ).to_edge(DOWN, buff=0.28)
        )

        self.add(time_axes, spec_axes, time_label, spec_label, wave, peak, readout)
        self.wait(0.45)
        self.play(freq.animate.set_value(4.0), run_time=5.5, rate_func=smooth)
        self.wait(0.6)


def rect_spectrum(xi, width, amplitude=1.0):
    """Magnitude of the transform of amplitude on [0, width], zero elsewhere."""
    values = np.asarray(xi, dtype=float)
    return np.abs(amplitude * width * np.sinc(values * width))


class RectPulse(Scene):
    """A rectangular pulse and the sinc spectrum that widens as the pulse shrinks."""

    def construct(self):
        paper(self)
        amplitude = 1.0
        width = ValueTracker(1.35)

        time_axes = axes([-0.35, 2.5, 0.5], [-0.25, 1.55, 0.5], 6.2, 4.3)
        time_axes.shift(LEFT * 3.35 + DOWN * 0.15)
        spec_axes = axes([-5, 5, 1], [0, 1.55, 0.5], 6.2, 4.3)
        spec_axes.shift(RIGHT * 3.35 + DOWN * 0.15)

        time_label = Text("f(x)", font_size=28, color=INK).next_to(time_axes, UP, buff=0.12)
        spec_label = Text("|f̂(ξ)|", font_size=28, color=INK).next_to(spec_axes, UP, buff=0.12)

        pulse = always_redraw(lambda: self._pulse(time_axes, width.get_value(), amplitude))
        spectrum = always_redraw(
            lambda: spec_axes.plot(
                lambda xi: rect_spectrum(xi, width.get_value(), amplitude),
                x_range=[-5, 5, 0.02],
                color=CORAL,
                stroke_width=4,
            )
        )
        readout = always_redraw(
            lambda: Text(
                f"A = 1     X = {width.get_value():.2f}     0 ailleurs",
                font_size=28,
                color=INK,
            ).to_edge(DOWN, buff=0.28)
        )

        self.add(time_axes, spec_axes, time_label, spec_label, pulse, spectrum, readout)
        self.wait(0.6)
        self.play(width.animate.set_value(0.42), run_time=4.5, rate_func=smooth)
        self.wait(0.7)

    def _pulse(self, plot, width, amplitude):
        jump = {"color": AMBER, "stroke_width": 3}
        level = {"color": BLUE_C, "stroke_width": 4.5}
        return VGroup(
            Line(plot.c2p(-0.35, 0), plot.c2p(0, 0), **level),
            Line(plot.c2p(0, 0), plot.c2p(0, amplitude), **jump),
            Line(plot.c2p(0, amplitude), plot.c2p(width, amplitude), **level),
            Line(plot.c2p(width, amplitude), plot.c2p(width, 0), **jump),
            Line(plot.c2p(width, 0), plot.c2p(2.5, 0), **level),
        )


def heart_vectors():
    """Fourier vectors of a closed heart outline, scaled to fit the frame."""
    count = 256
    theta = TAU * np.arange(count) / count
    x = 16 * np.sin(theta) ** 3
    y = 13 * np.cos(theta) - 5 * np.cos(2 * theta) - 2 * np.cos(3 * theta) - np.cos(4 * theta)
    samples = x + 1j * y
    coeffs = np.fft.fft(samples) / count
    freqs = np.fft.fftfreq(count, d=1 / count)
    peak = np.max(np.abs(coeffs))
    pairs = [(float(freq), coeff) for freq, coeff in zip(freqs, coeffs) if abs(coeff) > peak * 0.02]
    pairs.sort(key=lambda item: -abs(item[1]))
    times = np.linspace(0, 1, 300, endpoint=False)
    orbit = sum(coeff * np.exp(2j * np.pi * freq * times) for freq, coeff in pairs)
    scale = 2.55 / np.max(np.abs(orbit))
    return [(freq, coeff * scale) for freq, coeff in pairs]


def chain_tip(vectors, time):
    point = 0j
    for freq, coeff in vectors:
        point += coeff * np.exp(2j * np.pi * freq * time)
    return point


class EpicycleDraw(Scene):
    """One rotating radius draws a circle; stacking radii draws a closed outline."""

    def construct(self):
        paper(self)
        vectors = heart_vectors()
        time = ValueTracker(0.0)
        count = ValueTracker(1.0)
        total = len(vectors)
        caption = always_redraw(lambda: self._caption(int(round(count.get_value())), total))
        figure = always_redraw(lambda: self._figure(vectors, time.get_value(), int(round(count.get_value()))))
        self.add(figure, caption)
        self.wait(0.25)
        self.play(time.animate.set_value(1), run_time=3.0, rate_func=linear)
        time.set_value(0.18)
        self.play(count.animate.set_value(total), run_time=2.8, rate_func=linear)
        time.set_value(0)
        self.wait(0.2)
        self.play(time.animate.set_value(1), run_time=6.2, rate_func=linear)
        self.wait(0.4)

    def _caption(self, count, total):
        if count <= 1:
            message = "1 cercle : un cosinus et un sinus"
        elif count < total:
            message = "l'extrémité du rayon devient le centre du suivant"
        else:
            message = "le dernier point trace le contour"
        return Text(message, font_size=28, color=INK).to_edge(DOWN, buff=0.28)

    def _figure(self, vectors, time, count):
        used = vectors[: max(1, count)]
        show_path = count <= 1 or count >= len(vectors)
        wrapped = 1.0 if time > 0 and np.isclose(time % 1, 0) else time % 1
        point = 0j
        circles = VGroup()
        radii = VGroup()
        joints = VGroup()
        for freq, coeff in used:
            nxt = point + coeff * np.exp(2j * np.pi * freq * wrapped)
            radius = abs(coeff)
            if radius > 0.015:
                circles.add(
                    Circle(radius=radius, color=AXIS, stroke_width=2.2).move_to(self._xy(point))
                )
                radii.add(Line(self._xy(point), self._xy(nxt), color=BLUE_C, stroke_width=3))
            joints.add(Dot(self._xy(nxt), radius=0.055, color=BLUE_C))
            point = nxt
        if len(joints) > 0:
            joints[-1].set_color(CORAL).scale(1.35)

        parts = [circles, radii, joints]
        if show_path and wrapped > 0.01:
            steps = max(2, int(220 * wrapped))
            samples = [chain_tip(used, t) for t in np.linspace(0, wrapped, steps)]
            path = VMobject(stroke_color=CORAL, stroke_width=5)
            path.set_points_as_corners([self._xy(sample) for sample in samples])
            parts.append(path)

        drawn = VGroup(*parts)
        drawn.move_to(UP * 0.15)
        return drawn

    def _xy(self, value):
        return np.array([np.real(value), np.imag(value), 0.0])
