/**
 * 3D galaxy visualization using plain Three.js.
 *
 * Renders products as instanced points in 3D space using a ref-mounted
 * Three.js scene. Uses OrbitControls for navigation and raycasting
 * for click and hover interaction. Does not depend on R3F (which requires React 19).
 *
 * @param nodes - Array of galaxy nodes to render
 * @param onNodeClick - Called with productId when a star is clicked
 * @param onNodeHover - Called with node and screen position on hover, or null on unhover
 */

import { useEffect, useRef } from "react";
import type { PUGalaxyNode } from "@price-game/shared";

interface GalaxyViewProps {
  nodes: PUGalaxyNode[];
  onNodeClick?: (productId: number) => void;
  onNodeHover?: (
    node: PUGalaxyNode | null,
    screenPos: { x: number; y: number } | null,
  ) => void;
}

const CLUSTER_COLORS = [
  0xe74c3c, 0x3498db, 0x2ecc71, 0xf39c12, 0x9b59b6,
  0x1abc9c, 0xe67e22, 0x34495e, 0xe91e63, 0x00bcd4,
];

export default function GalaxyView({ nodes, onNodeClick, onNodeHover }: GalaxyViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  const onNodeHoverRef = useRef(onNodeHover);
  onNodeHoverRef.current = onNodeHover;

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    let disposed = false;

    import("three").then((THREE) => {
      if (disposed || !containerRef.current) return;

      const container = containerRef.current;
      const width = container.clientWidth;
      const height = 600;

      // Scene setup
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0a0a1a);

      const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
      camera.position.set(0, 50, 150);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      container.appendChild(renderer.domElement);

      // Lighting
      scene.add(new THREE.AmbientLight(0xffffff, 0.5));
      const pointLight = new THREE.PointLight(0xffffff, 1);
      pointLight.position.set(100, 100, 100);
      scene.add(pointLight);

      // Create individual meshes for each node
      const geometry = new THREE.SphereGeometry(1.2, 12, 12);
      const material = new THREE.MeshStandardMaterial({ vertexColors: false });

      const group = new THREE.Group();
      const meshes: InstanceType<typeof THREE.Mesh>[] = [];

      for (const node of nodes) {
        const mat = new THREE.MeshStandardMaterial({
          color: CLUSTER_COLORS[(node.cluster ?? 0) % CLUSTER_COLORS.length],
        });
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.position.set(node.x, node.y, node.z);
        mesh.userData = { productId: node.productId };
        group.add(mesh);
        meshes.push(mesh);
      }
      scene.add(group);

      // Simple orbit-style controls via mouse
      let isDragging = false;
      let prevX = 0;
      let prevY = 0;
      let rotY = 0;
      let rotX = 0;
      let mouseDownX = 0;
      let mouseDownY = 0;
      let hoveredId: number | null = null;

      const onMouseDown = (e: MouseEvent) => {
        isDragging = true;
        prevX = e.clientX;
        prevY = e.clientY;
        mouseDownX = e.clientX;
        mouseDownY = e.clientY;
        renderer.domElement.style.cursor = "grabbing";
      };

      const hoverRaycaster = new THREE.Raycaster();
      const hoverMouse = new THREE.Vector2();

      const onMouseMove = (e: MouseEvent) => {
        if (isDragging) {
          rotY += (e.clientX - prevX) * 0.005;
          rotX += (e.clientY - prevY) * 0.005;
          rotX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotX));
          prevX = e.clientX;
          prevY = e.clientY;
          return;
        }

        // Hover raycasting
        const rect = renderer.domElement.getBoundingClientRect();
        hoverMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        hoverMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        hoverRaycaster.setFromCamera(hoverMouse, camera);
        const hits = hoverRaycaster.intersectObjects(meshes);

        if (hits.length > 0) {
          const hitProductId = hits[0].object.userData.productId;
          if (hitProductId !== hoveredId) {
            hoveredId = hitProductId;
            renderer.domElement.style.cursor = "pointer";
            const matchedNode = nodesRef.current.find((n) => n.productId === hitProductId) ?? null;
            if (onNodeHoverRef.current && matchedNode) {
              // Project mesh position to screen coords
              const worldPos = hits[0].object.position.clone();
              worldPos.project(camera);
              const sx = ((worldPos.x + 1) / 2) * rect.width + rect.left;
              const sy = ((-worldPos.y + 1) / 2) * rect.height + rect.top;
              onNodeHoverRef.current(matchedNode, { x: sx, y: sy });
            }
          }
        } else if (hoveredId !== null) {
          hoveredId = null;
          renderer.domElement.style.cursor = "grab";
          onNodeHoverRef.current?.(null, null);
        }
      };

      const onMouseUp = () => {
        isDragging = false;
        renderer.domElement.style.cursor = hoveredId ? "pointer" : "grab";
      };

      let zoom = 150;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        zoom = Math.max(20, Math.min(500, zoom + e.deltaY * 0.1));
      };

      renderer.domElement.style.cursor = "grab";
      renderer.domElement.addEventListener("mousedown", onMouseDown);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

      // Click detection via raycaster (with drag guard)
      const raycaster = new THREE.Raycaster();
      raycaster.params.Mesh = { threshold: 1.5 };
      const mouse = new THREE.Vector2();

      const onClick = (e: MouseEvent) => {
        // Drag guard: ignore click if mouse moved more than 5px from mousedown
        const dx = e.clientX - mouseDownX;
        const dy = e.clientY - mouseDownY;
        if (dx * dx + dy * dy > 25) return;

        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(meshes);
        if (intersects.length > 0 && onNodeClickRef.current) {
          onNodeClickRef.current(intersects[0].object.userData.productId);
        }
      };
      renderer.domElement.addEventListener("click", onClick);

      // Auto-rotation + camera orbit
      let autoRotation = 0;

      function animate() {
        if (disposed) return;
        requestAnimationFrame(animate);

        // Pause auto-rotation when hovering (slow drift)
        autoRotation += hoveredId ? 0 : 0.0002;
        const effectiveRotY = rotY + autoRotation;

        camera.position.x = Math.sin(effectiveRotY) * Math.cos(rotX) * zoom;
        camera.position.y = Math.sin(rotX) * zoom;
        camera.position.z = Math.cos(effectiveRotY) * Math.cos(rotX) * zoom;
        camera.lookAt(0, 0, 0);

        // Scale animation: lerp hovered mesh toward 2.0, others toward 1.0
        for (const mesh of meshes) {
          const targetScale = mesh.userData.productId === hoveredId ? 2.0 : 1.0;
          const s = mesh.scale.x + (targetScale - mesh.scale.x) * 0.15;
          mesh.scale.set(s, s, s);
        }

        renderer.render(scene, camera);
      }
      animate();

      // Resize handler
      const onResize = () => {
        if (!containerRef.current) return;
        const w = containerRef.current.clientWidth;
        camera.aspect = w / height;
        camera.updateProjectionMatrix();
        renderer.setSize(w, height);
      };
      window.addEventListener("resize", onResize);

      cleanupRef.current = () => {
        disposed = true;
        renderer.domElement.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        renderer.domElement.removeEventListener("wheel", onWheel);
        renderer.domElement.removeEventListener("click", onClick);
        window.removeEventListener("resize", onResize);
        renderer.dispose();
        geometry.dispose();
        material.dispose();
        meshes.forEach((m) => (m.material as { dispose(): void }).dispose());
        if (container.contains(renderer.domElement)) {
          container.removeChild(renderer.domElement);
        }
      };
    });

    return () => {
      disposed = true;
      if (cleanupRef.current) cleanupRef.current();
    };
  }, [nodes]);

  if (nodes.length === 0) {
    return <p className="pu-muted">No galaxy data available yet. Enrich some products to populate the galaxy.</p>;
  }

  return (
    <div className="pu-galaxy-container">
      <div ref={containerRef} style={{ height: "600px", width: "100%" }} />
    </div>
  );
}
