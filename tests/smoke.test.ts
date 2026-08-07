import { describe, it, expect, afterAll } from "vitest";
import { testDb, resetDb, closeDb, makeUser } from "./helpers/db";
import { users } from "@/db/schema";

describe("harness", () => {
  afterAll(closeDb);
  it("connects to the test database and isolates data", async () => {
    await resetDb();
    await makeUser({ email: "harness@test.local" });
    const rows = await testDb.select().from(users);
    expect(rows).toHaveLength(1);
    await resetDb();
    expect(await testDb.select().from(users)).toHaveLength(0);
  });
});
