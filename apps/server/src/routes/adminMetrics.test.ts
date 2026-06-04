import { describe, it, expect, vi } from "vitest";
import express from "express";
import { createAdminMetricsRouter } from "./adminMetrics";
import type { Server as IoServer } from "socket.io";

vi.mock("../middleware/adminAuth", () => {
  // Bypass admin auth in unit tests — we trust requireAdmin's own tests.
  // The point of this suite is the response shape and reset semantics.
  // Both middlewares mocked because the router chains requireAdmin +
  // require2faEnrolled (PR3 sec review followup).
  return {
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    require2faEnrolled: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

function mockIo(clients: number): IoServer {
  return { engine: { clientsCount: clients } } as unknown as IoServer;
}

function callMetrics(io: IoServer): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use("/api/admin/metrics", createAdminMetricsRouter(io));
  return new Promise((resolve) => {
    const req = { method: "GET", url: "/api/admin/metrics" } as unknown as { method: string; url: string };
    let captured: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
    const res = {
      statusCode: 200,
      status(code: number) {
        captured.status = code;
        return res;
      },
      json(body: Record<string, unknown>) {
        captured = { status: this.statusCode, body };
        resolve(captured);
        return res;
      },
      setHeader: () => res,
      end: () => resolve(captured),
    } as unknown as Parameters<express.Application["handle"]>[1];
    (app as unknown as {
      handle: (req: unknown, res: unknown) => void;
    }).handle(req, res);
  });
}

describe("createAdminMetricsRouter", () => {
  it("returns the expected response shape with positive memory + connection counts", async () => {
    const { status, body } = await callMetrics(mockIo(7));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      memory: expect.objectContaining({
        rssMb: expect.any(Number),
        heapUsedMb: expect.any(Number),
        heapTotalMb: expect.any(Number),
      }),
      cpu: expect.objectContaining({
        userMs: expect.any(Number),
        systemMs: expect.any(Number),
      }),
      eventLoopLagMs: expect.objectContaining({
        p50: expect.any(Number),
        p99: expect.any(Number),
        max: expect.any(Number),
      }),
      socketsConnected: 7,
      pid: process.pid,
      nodeVersion: process.version,
    });
    expect((body.memory as { rssMb: number }).rssMb).toBeGreaterThan(0);
  });

  it("reports zero connections when no sockets are attached", async () => {
    const { body } = await callMetrics({ engine: { clientsCount: 0 } } as unknown as IoServer);
    expect(body.socketsConnected).toBe(0);
  });
});
