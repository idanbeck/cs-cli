// Debug test scene - floor and three colored boxes
import { Renderer, RenderObject } from './engine/Renderer.js';
import { Mesh } from './engine/Mesh.js';
import { Transform } from './engine/Transform.js';
import { Vector3 } from './engine/math/Vector3.js';
import { Color, CURSOR_HIDE, CURSOR_SHOW, ALT_SCREEN_ON, ALT_SCREEN_OFF, RESET } from './utils/Colors.js';
import { degToRad } from './engine/math/MathUtils.js';

// Create a simple floor mesh with explicit winding for debugging
function createDebugFloor(size: number, color: Color): Mesh {
  const mesh = new Mesh({ name: 'debug_floor', color });
  const hs = size / 2;

  // Four corners of the floor at y=0
  // Looking down from +Y (bird's eye view):
  //   -Z (back)
  //     0 --- 1     (back-left, back-right)
  //     |     |
  //     3 --- 2     (front-left, front-right)
  //   +Z (front)

  mesh.addVertex(new Vector3(-hs, 0, -hs), new Vector3(0, 1, 0)); // 0 - back left
  mesh.addVertex(new Vector3(hs, 0, -hs), new Vector3(0, 1, 0));  // 1 - back right
  mesh.addVertex(new Vector3(hs, 0, hs), new Vector3(0, 1, 0));   // 2 - front right
  mesh.addVertex(new Vector3(-hs, 0, hs), new Vector3(0, 1, 0));  // 3 - front left

  // Match box top-face winding: (front-left, back-right, front-right), (front-left, back-left, back-right)
  // Using our indices: (3, 1, 2) and (3, 0, 1)
  mesh.addTriangle(3, 1, 2, false);
  mesh.addTriangle(3, 0, 1, false);

  return mesh;
}

async function main() {
  const width = process.stdout.columns || 120;
  const height = (process.stdout.rows || 30) - 2;

  const renderer = new Renderer(width, height);
  renderer.showStats = true;
  renderer.setClearColor(new Color(40, 60, 80)); // Sky blue-gray

  const rasterizer = renderer.getRasterizer();
  rasterizer.enableDepthShading = true;
  rasterizer.enableLighting = true;
  rasterizer.ambientLight = 0.4;

  // Create debug floor (gray)
  const floor = createDebugFloor(20, new Color(100, 100, 100));
  const floorTransform = new Transform(new Vector3(0, 0, 0));

  // Create three colored boxes
  const redBox = Mesh.createBox(2, 2, 2, { name: 'red', color: new Color(200, 50, 50) });
  const greenBox = Mesh.createBox(2, 2, 2, { name: 'green', color: new Color(50, 200, 50) });
  const blueBox = Mesh.createBox(2, 2, 2, { name: 'blue', color: new Color(50, 50, 200) });

  // Position boxes on the floor
  const redTransform = new Transform(new Vector3(-4, 1, 0));    // Left
  const greenTransform = new Transform(new Vector3(0, 1, -4));  // Back center
  const blueTransform = new Transform(new Vector3(4, 1, 0));    // Right

  // Add objects to renderer
  renderer.addObject({ mesh: floor, transform: floorTransform, visible: true });
  renderer.addObject({ mesh: redBox, transform: redTransform, visible: true });
  renderer.addObject({ mesh: greenBox, transform: greenTransform, visible: true });
  renderer.addObject({ mesh: blueBox, transform: blueTransform, visible: true });

  // Position camera
  const camera = renderer.getCamera();
  camera.setPosition(0, 5, 10);  // Above and back
  camera.setPitch(degToRad(-20)); // Look down slightly
  camera.setYaw(0);

  // Enter fullscreen
  process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);

  let running = true;
  let angle = 0;

  const handleInput = (data: Buffer) => {
    const str = data.toString();
    if (str === 'q' || str === '\x1b') {
      running = false;
    }
    // Camera controls
    if (str === 'w') camera.translate(0, 0, -0.5);
    if (str === 's') camera.translate(0, 0, 0.5);
    if (str === 'a') camera.translate(-0.5, 0, 0);
    if (str === 'd') camera.translate(0.5, 0, 0);
    if (str === 'r') camera.translate(0, 0.5, 0);  // Rise
    if (str === 'f') camera.translate(0, -0.5, 0); // Fall
    if (str === '\x1b[A') camera.rotate(degToRad(5), 0);  // Look up
    if (str === '\x1b[B') camera.rotate(degToRad(-5), 0); // Look down
    if (str === '\x1b[C') camera.rotate(0, degToRad(-5)); // Turn right
    if (str === '\x1b[D') camera.rotate(0, degToRad(5));  // Turn left
    // Toggle backface culling
    if (str === 'b') {
      rasterizer.enableBackfaceCulling = !rasterizer.enableBackfaceCulling;
    }
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);

  const gameLoop = () => {
    if (!running) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF + RESET);
      console.log('Debug scene exited.');
      console.log('Backface culling was:', rasterizer.enableBackfaceCulling ? 'ON' : 'OFF');
      process.exit(0);
    }

    // Slowly rotate boxes for visual interest
    angle += 0.02;
    redTransform.setRotationEuler(0, angle, 0);
    greenTransform.setRotationEuler(0, -angle * 0.7, 0);
    blueTransform.setRotationEuler(0, angle * 1.3, 0);

    renderer.render();
    setTimeout(gameLoop, 1000 / 30);
  };

  console.log('Debug Test Scene');
  console.log('Controls: WASD=move, RF=up/down, Arrows=look, B=toggle backface cull, Q/Esc=quit');
  console.log('Press any key to start...');

  await new Promise<void>(resolve => {
    process.stdin.once('data', () => resolve());
  });

  gameLoop();
}

main().catch(console.error);
