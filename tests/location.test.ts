import { expect, test } from "bun:test";
import { LocationTrial, parseLocationLink } from "../src/location.ts";

test("accepts explicit Apple and Google coordinates, including zero", () => {
  expect(parseLocationLink("https://maps.apple.com/?ll=0,0")).toEqual({latitude:0,longitude:0});
  expect(parseLocationLink("https://maps.apple.com/place?coordinate=47.6%2C-122.3")).toEqual({latitude:47.6,longitude:-122.3});
  expect(parseLocationLink("https://www.google.com/maps/search/?api=1&query=47.6,-122.3")).toEqual({latitude:47.6,longitude:-122.3});
});
test("rejects invalid coordinates, unrelated hosts, and ambiguous place searches", () => {
  for (const link of ["https://maps.apple.com/?ll=91,0", "https://maps.apple.com/?ll=0,-181", "https://evil.test/?ll=47,-122", "https://maps.apple.com.evil.test/?ll=47,-122", "https://maps.apple.com/?q=library", "https://maps.app.goo.gl/example"])
    expect(parseLocationLink(link)).toBeNull();
});
test("isolates conversations, expires pins, supports explicit deletion and reset", () => {
  let now = 1000;
  const trial = new LocationTrial(() => now);
  trial.handle("a", "https://maps.apple.com/?ll=47,-122");
  expect(trial.handle("b", "where am i")).toContain("don't have");
  expect(trial.handle("a", "location name library")).toContain("library");
  expect(trial.handle("a", "where am i")).toContain("library");
  now += 3_600_000;
  expect(trial.handle("a", "where am i")).toContain("don't have");
  trial.handle("a", "https://maps.apple.com/?ll=0,0");
  trial.handle("a", "forget location");
  expect(trial.handle("a", "where am i")).toContain("don't have");
  trial.handle("a", "https://maps.apple.com/?ll=0,0");
  expect(trial.handle("a", "reset")).toBeNull();
  expect(trial.handle("a", "where am i")).toContain("don't have");
});
