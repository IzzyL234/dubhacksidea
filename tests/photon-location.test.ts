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

test("provider failures do not falsely blame sharing or reveal raw SDK errors",async()=>{
 const {getPhotonLocationStatus,PhotonLocationError}=await import('../src/photon-location.ts');
 const reply=await getPhotonLocationStatus('+15555550123',async()=>{throw new PhotonLocationError('service_error');});
 expect(reply).toContain("doesn't prove location sharing stopped");expect(reply).toContain("haven't checked your building");expect(reply).not.toContain('15555550123');
});
test("sanitized categories distinguish missing sharing, authentication, timeout and service errors",async()=>{
 const {locationFailureKind,locationFailureReply}=await import('../src/photon-location.ts');
 expect(locationFailureKind({code:'internalError',message:'private raw payload'})).toBe('service_error');
 expect(locationFailureKind({code:'sharedFriendLocationNotFound'})).toBe('not_shared');
 expect(locationFailureKind({code:'tokenExpired'})).toBe('authentication');
 expect(locationFailureKind({grpcCode:4})).toBe('timeout');
 expect(locationFailureReply({code:'internalError',message:'private raw payload'})).not.toContain('private raw payload');
 expect(locationFailureReply({code:'sharedFriendLocationNotFound'})).toContain('Check Find My');
});
