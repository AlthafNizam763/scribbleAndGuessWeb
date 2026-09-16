import {
  BLUE,
  GREEN,
  GREY,
  ORANGE,
  RED,
  YELLOW,
  arc,
  circle,
  closed,
  dot,
  ellipse,
  ink,
  line,
  path,
  rays,
  rect,
  tint,
  triangle,
  zigzag,
  type TemplateBuilder,
} from '@/services/bot/drawingShapes';

/**
 * Vehicles and technology.
 *
 * A screen on a stand is a television, a computer or a laptop depending on one
 * detail each, and a box on wheels is a car, a bus or a truck depending on how
 * many windows it has. Those details are load-bearing, so each of these puts
 * them in before the ornament — a bus gets its row of windows before it gets
 * its headlights.
 */
export const MACHINE_TEMPLATES: Readonly<Record<string, TemplateBuilder>> = Object.freeze({
  /** Car. A side profile: bonnet, cabin, two wheels. */
  car: () => [
    ink(
      path([
        [0.18, 0.62],
        [0.2, 0.5],
        [0.34, 0.5],
        [0.42, 0.36],
        [0.62, 0.36],
        [0.7, 0.5],
        [0.82, 0.52],
        [0.82, 0.62],
        [0.18, 0.62],
      ]),
    ),
    ink(line(0.52, 0.38, 0.52, 0.5), 2),
    ink(circle(0.34, 0.65, 0.07)),
    ink(circle(0.68, 0.65, 0.07)),
    ink(circle(0.34, 0.65, 0.025, 10), 2),
    ink(circle(0.68, 0.65, 0.025, 10), 2),
    tint(circle(0.8, 0.56, 0.02, 8), YELLOW, 3),
  ],

  /** Bus. A long box with a row of windows and a door. */
  bus: () => [
    ink(rect(0.12, 0.34, 0.88, 0.68)),
    ...Array.from({ length: 4 }, (_, i) => ink(rect(0.16 + i * 0.15, 0.4, 0.28 + i * 0.15, 0.52))),
    ink(rect(0.76, 0.4, 0.86, 0.6)),
    ink(line(0.81, 0.4, 0.81, 0.6), 2),
    ink(circle(0.28, 0.7, 0.07)),
    ink(circle(0.7, 0.7, 0.07)),
    tint(line(0.12, 0.58, 0.74, 0.58), RED, 5),
  ],

  /** Bicycle. Two wheels, a diamond frame, bars and a saddle. */
  bicycle: () => [
    ink(circle(0.28, 0.62, 0.15, 22)),
    ink(circle(0.72, 0.62, 0.15, 22)),
    ink(path([[0.28, 0.62], [0.44, 0.62], [0.54, 0.4], [0.72, 0.62]])),
    ink(line(0.44, 0.62, 0.54, 0.4)),
    ink(line(0.54, 0.4, 0.64, 0.4)),
    ink(line(0.38, 0.44, 0.48, 0.44), 3),
    ink(line(0.44, 0.44, 0.44, 0.62), 2),
    ink(circle(0.44, 0.62, 0.035, 10), 2),
  ],

  /** Boat. A hull, a mast and two sails, on a water line. */
  boat: () => [
    ink(path([[0.2, 0.62], [0.8, 0.62], [0.68, 0.76], [0.32, 0.76], [0.2, 0.62]])),
    ink(line(0.5, 0.62, 0.5, 0.2)),
    tint(closed([[0.53, 0.24], [0.76, 0.48], [0.53, 0.56]]), RED, 5),
    tint(closed([[0.47, 0.3], [0.26, 0.5], [0.47, 0.56]]), BLUE, 5),
    tint(path([[0.12, 0.82], [0.28, 0.8], [0.44, 0.82], [0.6, 0.8], [0.76, 0.82], [0.9, 0.8]]), BLUE, 4),
  ],

  /** Rocket. A cone, a body, fins and exhaust. */
  rocket: () => [
    ink(triangle(0.5, 0.12, 0.62, 0.34, 0.38, 0.34)),
    ink(rect(0.38, 0.34, 0.62, 0.66)),
    ink(circle(0.5, 0.44, 0.06, 14), 3),
    ink(path([[0.38, 0.52], [0.26, 0.72], [0.38, 0.66]])),
    ink(path([[0.62, 0.52], [0.74, 0.72], [0.62, 0.66]])),
    tint(path([[0.44, 0.66], [0.5, 0.84], [0.56, 0.66]]), ORANGE, 5),
  ],

  /** Train. An engine with a funnel, a cab and driving wheels. */
  train: () => [
    ink(rect(0.16, 0.44, 0.62, 0.68)),
    ink(rect(0.62, 0.32, 0.86, 0.68)),
    ink(rect(0.68, 0.38, 0.8, 0.5)),
    ink(path([[0.24, 0.44], [0.24, 0.3], [0.32, 0.3], [0.32, 0.44]])),
    tint(circle(0.28, 0.24, 0.06), GREY, 4),
    ink(circle(0.28, 0.72, 0.06)),
    ink(circle(0.46, 0.72, 0.06)),
    ink(circle(0.74, 0.72, 0.08)),
    ink(line(0.12, 0.78, 0.9, 0.78), 3),
  ],

  /** Airplane. A fuselage, swept wings and a tail fin. */
  airplane: () => [
    ink(path([[0.16, 0.5], [0.3, 0.44], [0.78, 0.44], [0.88, 0.5], [0.78, 0.56], [0.3, 0.56], [0.16, 0.5]])),
    ink(path([[0.44, 0.46], [0.34, 0.24], [0.5, 0.24], [0.6, 0.46]])),
    ink(path([[0.44, 0.54], [0.34, 0.74], [0.5, 0.74], [0.6, 0.54]])),
    ink(path([[0.72, 0.44], [0.78, 0.3], [0.86, 0.3], [0.82, 0.44]])),
    ink(circle(0.32, 0.5, 0.02, 8), 2),
    ink(circle(0.4, 0.5, 0.02, 8), 2),
  ],

  /** Truck. A cab and a box body on three axles. */
  truck: () => [
    ink(rect(0.4, 0.34, 0.88, 0.64)),
    ink(path([[0.12, 0.64], [0.14, 0.46], [0.28, 0.46], [0.36, 0.36], [0.4, 0.36], [0.4, 0.64]])),
    ink(rect(0.18, 0.46, 0.3, 0.55)),
    ink(circle(0.26, 0.68, 0.07)),
    ink(circle(0.62, 0.68, 0.07)),
    ink(circle(0.78, 0.68, 0.07)),
    ink(line(0.4, 0.34, 0.4, 0.64), 2),
  ],

  /** Phone. A slab with a screen, a speaker slot and a button. */
  phone: () => [
    ink(rect(0.4, 0.2, 0.6, 0.8)),
    ink(rect(0.43, 0.27, 0.57, 0.71), ),
    ink(circle(0.5, 0.755, 0.018, 10), 2),
    ink(line(0.46, 0.235, 0.54, 0.235), 3),
  ],

  /** Laptop. A hinged screen over a keyboard deck. */
  laptop: () => [
    ink(rect(0.28, 0.26, 0.72, 0.58)),
    ink(rect(0.32, 0.3, 0.68, 0.54), ),
    ink(closed([[0.24, 0.58], [0.76, 0.58], [0.82, 0.68], [0.18, 0.68]])),
    ink(line(0.36, 0.63, 0.64, 0.63), 2),
  ],

  /** Computer. A monitor on a stand, with a tower beside it. */
  computer: () => [
    ink(rect(0.26, 0.24, 0.72, 0.56)),
    ink(rect(0.3, 0.28, 0.68, 0.52), ),
    ink(path([[0.44, 0.56], [0.44, 0.64], [0.56, 0.64], [0.56, 0.56]])),
    ink(line(0.34, 0.68, 0.66, 0.68), 5),
    ink(rect(0.76, 0.42, 0.9, 0.68)),
    ink(circle(0.83, 0.47, 0.018, 8), 2),
  ],

  /** Keyboard. A tray of keys with a space bar. */
  keyboard: () => [
    ink(rect(0.12, 0.38, 0.88, 0.66)),
    ...Array.from({ length: 3 }, (_, row) =>
      ink(line(0.16, 0.44 + row * 0.06, 0.84, 0.44 + row * 0.06), 2),
    ),
    ...Array.from({ length: 7 }, (_, i) => ink(line(0.2 + i * 0.1, 0.41, 0.2 + i * 0.1, 0.56), 2)),
    ink(rect(0.34, 0.59, 0.66, 0.63)),
  ],

  /** Camera. A body, a lens, a viewfinder and a flash. */
  camera: () => [
    ink(rect(0.2, 0.38, 0.8, 0.7)),
    ink(path([[0.36, 0.38], [0.4, 0.3], [0.56, 0.3], [0.6, 0.38]])),
    ink(circle(0.5, 0.54, 0.13)),
    ink(circle(0.5, 0.54, 0.07, 14), 2),
    ink(circle(0.7, 0.44, 0.025, 10), 3),
    ink(rect(0.24, 0.42, 0.32, 0.47), ),
  ],

  /** Television. A boxy set with an aerial and a control panel. */
  television: () => [
    ink(rect(0.18, 0.34, 0.76, 0.72)),
    ink(rect(0.22, 0.38, 0.66, 0.68), ),
    ink(circle(0.71, 0.44, 0.022, 10), 2),
    ink(circle(0.71, 0.52, 0.022, 10), 2),
    ink(line(0.44, 0.34, 0.3, 0.18), 3),
    ink(line(0.5, 0.34, 0.66, 0.18), 3),
    ink(line(0.26, 0.72, 0.26, 0.8), 3),
    ink(line(0.68, 0.72, 0.68, 0.8), 3),
  ],

  /** Radio. A set with a dial, a speaker grille and an aerial. */
  radio: () => [
    ink(rect(0.18, 0.4, 0.82, 0.72)),
    ink(circle(0.34, 0.56, 0.1)),
    ...Array.from({ length: 4 }, (_, i) => ink(line(0.52, 0.46 + i * 0.07, 0.76, 0.46 + i * 0.07), 3)),
    ink(circle(0.34, 0.56, 0.02, 8), 2),
    ink(line(0.7, 0.4, 0.84, 0.2), 3),
    ink(circle(0.85, 0.18, 0.02, 8), 2),
  ],

  /** Robot. A boxy head and body with antenna, bolts and claws. */
  robot: () => [
    ink(rect(0.34, 0.24, 0.66, 0.46)),
    ...[
      [0.43, 0.33],
      [0.57, 0.33],
    ].map(([x, y]) => ink(circle(x as number, y as number, 0.035, 12), 3)),
    ink(zigzag(0.42, 0.41, 0.58, 0.41, 3, 0.02), 2),
    ink(line(0.5, 0.24, 0.5, 0.16), 3),
    ink(circle(0.5, 0.14, 0.025, 10), 3),
    ink(rect(0.32, 0.48, 0.68, 0.76)),
    ink(rect(0.42, 0.54, 0.58, 0.64), ),
    ink(path([[0.32, 0.54], [0.2, 0.6], [0.2, 0.68]]), 3),
    ink(path([[0.68, 0.54], [0.8, 0.6], [0.8, 0.68]]), 3),
    ink(line(0.4, 0.76, 0.4, 0.84), 4),
    ink(line(0.6, 0.76, 0.6, 0.84), 4),
  ],

  /** Battery. A cell with terminals and a charge bar. */
  battery: () => [
    ink(rect(0.22, 0.4, 0.78, 0.64)),
    ink(rect(0.78, 0.47, 0.84, 0.57)),
    ink(line(0.3, 0.44, 0.3, 0.6), 7),
    ink(line(0.4, 0.44, 0.4, 0.6), 7),
    ink(line(0.5, 0.44, 0.5, 0.6), 7),
    ink(line(0.62, 0.5, 0.7, 0.5), 3),
    ink(line(0.66, 0.46, 0.66, 0.54), 3),
  ],

  /** Plug. A body with two pins and a flex. */
  plug: () => [
    ink(rect(0.36, 0.42, 0.64, 0.7)),
    ink(line(0.43, 0.42, 0.43, 0.28), 6),
    ink(line(0.57, 0.42, 0.57, 0.28), 6),
    ink(path([[0.5, 0.7], [0.5, 0.78], [0.66, 0.84]]), 4),
  ],

  /** Lightbulb. A glass envelope, a filament and a screw base. */
  lightbulb: () => [
    ink(circle(0.5, 0.42, 0.18)),
    ink(path([[0.38, 0.55], [0.4, 0.64], [0.6, 0.64], [0.62, 0.55]])),
    ink(line(0.4, 0.68, 0.6, 0.68), 3),
    ink(line(0.41, 0.73, 0.59, 0.73), 3),
    ink(path([[0.44, 0.46], [0.47, 0.38], [0.5, 0.46], [0.53, 0.38], [0.56, 0.46]]), 2),
    ...rays(0.5, 0.42, 0.22, 0.3, 6, YELLOW, 3),
  ],

  /** Printer. A body with a paper tray and a sheet emerging. */
  printer: () => [
    ink(rect(0.2, 0.44, 0.8, 0.7)),
    ink(rect(0.34, 0.26, 0.66, 0.44)),
    ink(line(0.34, 0.34, 0.66, 0.34), 2),
    ink(rect(0.3, 0.5, 0.7, 0.56)),
    ink(circle(0.74, 0.62, 0.02, 8), 3),
    ink(path([[0.32, 0.7], [0.32, 0.8], [0.68, 0.8], [0.68, 0.7]]), 2),
  ],

  /** Speaker. A cabinet with two drivers. */
  speaker: () => [
    ink(rect(0.32, 0.22, 0.68, 0.8)),
    ink(circle(0.5, 0.38, 0.11)),
    ink(circle(0.5, 0.38, 0.045, 12), 2),
    ink(circle(0.5, 0.64, 0.07)),
    ink(circle(0.5, 0.64, 0.028, 10), 2),
  ],

  /** Microphone. A mesh head on a stand. */
  microphone: () => [
    ink(ellipse(0.5, 0.32, 0.11, 0.15, 20)),
    ink(line(0.41, 0.28, 0.59, 0.28), 2),
    ink(line(0.4, 0.34, 0.6, 0.34), 2),
    ink(line(0.42, 0.4, 0.58, 0.4), 2),
    ink(line(0.5, 0.47, 0.5, 0.74), 5),
    ink(arc(0.5, 0.78, 0.12, 0.06, Math.PI, Math.PI * 2, 10), 4),
  ],

  /** Satellite. A body with two solar panels and a dish. */
  satellite: () => [
    ink(rect(0.44, 0.42, 0.58, 0.62)),
    ink(rect(0.16, 0.44, 0.42, 0.6)),
    ink(rect(0.6, 0.44, 0.86, 0.6)),
    ink(line(0.24, 0.44, 0.24, 0.6), 2),
    ink(line(0.33, 0.44, 0.33, 0.6), 2),
    ink(line(0.69, 0.44, 0.69, 0.6), 2),
    ink(line(0.78, 0.44, 0.78, 0.6), 2),
    ink(arc(0.51, 0.34, 0.1, 0.09, Math.PI, Math.PI * 2, 12), 3),
    ink(line(0.51, 0.34, 0.51, 0.42), 2),
  ],

  /** Drone. A body with four arms and rotors. */
  drone: () => [
    ink(rect(0.42, 0.44, 0.58, 0.58)),
    ink(line(0.42, 0.44, 0.26, 0.34), 3),
    ink(line(0.58, 0.44, 0.74, 0.34), 3),
    ink(line(0.42, 0.58, 0.26, 0.68), 3),
    ink(line(0.58, 0.58, 0.74, 0.68), 3),
    ink(ellipse(0.24, 0.32, 0.09, 0.03, 14), 3),
    ink(ellipse(0.76, 0.32, 0.09, 0.03, 14), 3),
    ink(ellipse(0.24, 0.7, 0.09, 0.03, 14), 3),
    ink(ellipse(0.76, 0.7, 0.09, 0.03, 14), 3),
    ink(circle(0.5, 0.51, 0.025, 10), 2),
  ],

  /** Fan. A caged blade set on a pedestal. */
  fan: () => [
    ink(circle(0.5, 0.4, 0.2)),
    ...Array.from({ length: 4 }, (_, i) => {
      const angle = (i / 4) * Math.PI * 2;
      return ink(
        closed([
          [0.5, 0.4],
          [0.5 + Math.cos(angle) * 0.17, 0.4 + Math.sin(angle) * 0.17],
          [0.5 + Math.cos(angle + 0.9) * 0.15, 0.4 + Math.sin(angle + 0.9) * 0.15],
        ]),
        3,
      );
    }),
    ink(circle(0.5, 0.4, 0.03, 10), 3),
    ink(line(0.5, 0.6, 0.5, 0.78), 5),
    ink(line(0.36, 0.8, 0.64, 0.8), 5),
  ],

  /** Toaster. A body with two slots, a lever and two slices. */
  toaster: () => [
    ink(path([[0.2, 0.46], [0.24, 0.72], [0.76, 0.72], [0.8, 0.46], [0.2, 0.46]])),
    ink(line(0.3, 0.46, 0.46, 0.46), 4),
    ink(line(0.54, 0.46, 0.7, 0.46), 4),
    ink(path([[0.3, 0.46], [0.32, 0.34], [0.44, 0.34], [0.46, 0.46]]), 3),
    ink(line(0.82, 0.54, 0.82, 0.64), 5),
    ink(circle(0.7, 0.62, 0.025, 10), 2),
  ],

  /** Traffic light. Three lamps in a housing on a post. */
  'traffic light': () => [
    ink(rect(0.38, 0.16, 0.62, 0.66)),
    tint(circle(0.5, 0.26, 0.06), RED, 5),
    tint(circle(0.5, 0.41, 0.06), YELLOW, 5),
    tint(circle(0.5, 0.56, 0.06), GREEN, 5),
    ink(line(0.5, 0.66, 0.5, 0.84), 5),
    ink(line(0.4, 0.84, 0.6, 0.84), 4),
  ],

  /** Submarine. A hull with a conning tower, a periscope and portholes. */
  submarine: () => [
    ink(ellipse(0.5, 0.54, 0.3, 0.14)),
    ink(rect(0.44, 0.34, 0.58, 0.42)),
    ink(line(0.5, 0.34, 0.5, 0.24), 3),
    ink(line(0.5, 0.24, 0.58, 0.24), 3),
    ink(circle(0.36, 0.54, 0.035, 12), 3),
    ink(circle(0.5, 0.54, 0.035, 12), 3),
    ink(circle(0.64, 0.54, 0.035, 12), 3),
    ink(path([[0.8, 0.54], [0.88, 0.44], [0.88, 0.64], [0.8, 0.54]]), 3),
  ],

  /** Elevator. A shaft with doors and an arrow indicator. */
  elevator: () => [
    ink(rect(0.26, 0.24, 0.74, 0.8)),
    ink(line(0.5, 0.3, 0.5, 0.8), 3),
    ink(rect(0.3, 0.3, 0.7, 0.8), ),
    ink(path([[0.5, 0.14], [0.44, 0.22], [0.56, 0.22], [0.5, 0.14]]), 3),
    ink(circle(0.78, 0.5, 0.03, 10), 3),
  ],
});
