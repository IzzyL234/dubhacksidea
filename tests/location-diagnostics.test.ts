import {expect,test} from "bun:test";
import { LocationDiagnostics } from "../src/location-diagnostics.ts";
test("location diagnostics isolate chats, count only message shapes, and deduplicate",()=>{
  const d=new LocationDiagnostics();d.handle("a","location test");
  d.observe("a","1",{type:"custom",raw:{location:{latitude:47.123456,longitude:-122.987654},secret:"must-not-leak"}});
  d.observe("a","1",{type:"custom",raw:{latitude:47,longitude:-122}});
  const status=d.handle("a","location test status")!;
  expect(status).toContain("custom: 1");expect(status).toContain("fields: 1");
  expect(status).not.toContain("47.123456");expect(status).not.toContain("must-not-leak");
  expect(d.handle("b","location test status")).toContain("No active");
});
test("test expires and stop clears counters; static links never claim live tracking",()=>{
  let now=0;const d=new LocationDiagnostics(()=>now);d.handle("a","location test");
  d.observe("a","pin",{type:"richlink",url:"https://maps.apple.com/?ll=47,-122"});
  expect(d.handle("a","location test status")).toContain("Readable map links: 1");
  expect(d.handle("a","location test status")).toContain("doesn't prove live");
  now=10*60000;expect(d.handle("a","location test status")).toContain("No active");
  d.handle("a","location test");d.handle("a","location test stop");
  expect(d.handle("a","location test status")).toContain("No active");
});
