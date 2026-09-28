// Three.js backdrop: GPU particle field + wireframe icosahedron.
// Deliberately cheap (2 draw calls, no lights, no post) so it never competes
// with the ONNX session for GPU headroom. Pauses when the tab is hidden and
// when the user prefers reduced motion.
import * as THREE from 'three';

export function startBackdrop(canvas) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06080f, 0.055);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 60);
  camera.position.set(0, 0.4, 9);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return { pulse() {}, dispose() {} }; // WebGL unavailable: static CSS glows carry the look
  }
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // --- particle field: two interleaved accent colors ---
  const COUNT = 1600;
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);
  const seeds = new Float32Array(COUNT);
  const teal = new THREE.Color(0x5eead4);
  const indigo = new THREE.Color(0x818cf8);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 30;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 16;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 14 - 3;
    const c = i % 2 ? teal : indigo;
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    seeds[i] = Math.random() * Math.PI * 2;
  }
  const fieldGeo = new THREE.BufferGeometry();
  fieldGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  fieldGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const fieldMat = new THREE.PointsMaterial({
    size: 0.045,
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const field = new THREE.Points(fieldGeo, fieldMat);
  scene.add(field);

  // --- hero wireframe icosahedron ---
  const icoGeo = new THREE.IcosahedronGeometry(2.6, 1);
  const icoMat = new THREE.MeshBasicMaterial({
    color: 0x5eead4,
    wireframe: true,
    transparent: true,
    opacity: 0.14,
  });
  const ico = new THREE.Mesh(icoGeo, icoMat);
  ico.position.set(3.4, 0.6, -4);
  scene.add(ico);

  const icoGeo2 = new THREE.IcosahedronGeometry(1.4, 0);
  const ico2 = new THREE.Mesh(icoGeo2, icoMat.clone());
  ico2.material.color.set(0x818cf8);
  ico2.material.opacity = 0.18;
  ico2.position.set(-4.6, -0.8, -3);
  scene.add(ico2);

  // --- mouse parallax (lerped) ---
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  const onMouse = (e) => {
    target.x = (e.clientX / innerWidth) * 2 - 1;
    target.y = (e.clientY / innerHeight) * 2 - 1;
  };
  addEventListener('pointermove', onMouse, { passive: true });

  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', onResize);

  // Pulse: briefly excite the field when a decision completes.
  let pulse = 0;
  const clock = new THREE.Clock();
  let raf = 0;

  function frame() {
    raf = requestAnimationFrame(frame);
    const t = clock.getElapsedTime();
    current.x += (target.x - current.x) * 0.03;
    current.y += (target.y - current.y) * 0.03;
    pulse *= 0.94;

    camera.position.x = current.x * 0.6;
    camera.position.y = 0.4 - current.y * 0.4;
    camera.lookAt(0, 0, 0);

    const pos = fieldGeo.attributes.position.array;
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3 + 1] += Math.sin(t * 0.6 + seeds[i]) * 0.0016;
    }
    fieldGeo.attributes.position.needsUpdate = true;
    field.rotation.y = t * 0.02;
    fieldMat.opacity = 0.75 + pulse * 0.25;

    ico.rotation.x = t * 0.1;
    ico.rotation.y = t * 0.14;
    ico2.rotation.x = -t * 0.16;
    ico2.rotation.z = t * 0.1;

    renderer.render(scene, camera);
  }

  function visibilityPause() {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf && !reduced) {
      clock.getDelta(); // swallow the paused span
      frame();
    }
  }
  document.addEventListener('visibilitychange', visibilityPause);

  if (reduced) {
    renderer.render(scene, camera); // single static frame
  } else {
    frame();
  }

  return {
    pulse() { pulse = 1; },
    dispose() {
      cancelAnimationFrame(raf);
      removeEventListener('pointermove', onMouse);
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', visibilityPause);
      fieldGeo.dispose(); fieldMat.dispose();
      icoGeo.dispose(); icoGeo2.dispose(); icoMat.dispose();
      renderer.dispose();
    },
  };
}
