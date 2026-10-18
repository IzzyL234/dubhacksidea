import { expect,test } from "bun:test";
import {locationStatus} from "../src/photon-location.ts";
test("readable cached coordinates are distinguished from a live snapshot without exposing location",()=>{
  const reply=locationStatus({latitude:47.123456,longitude:-122.987654,locationType:"shallow",isLocatingInProgress:false,locationTimestamp:"2026-10-17T12:00:00Z"},Date.parse("2026-10-17T12:01:00Z"));
  expect(reply).toContain("Coordinates: available");expect(reply).toContain("Source: cached");expect(reply).toContain("about 1 minute");
  expect(reply).not.toContain("47.123456");expect(reply).not.toContain("-122.987654");
  expect(reply).toContain("doesn't confirm continuous");
});
test("source label alone cannot turn a missing coordinate into a valid live location",()=>{
  const reply=locationStatus({locationType:"live",isLocatingInProgress:true});
  expect(reply).toContain("not available yet");expect(reply).toContain("still locating");expect(reply).toContain("doesn't confirm continuous");
});
