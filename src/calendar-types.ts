export type DemoEvent = {
  id?:string|null;etag?:string|null;summary?:string|null;description?:string|null;status?:string|null;
  start?:{dateTime?:string|null;date?:string|null;timeZone?:string|null}|null;
  end?:{dateTime?:string|null;date?:string|null;timeZone?:string|null}|null;
  transparency?:string|null;attendees?:unknown[]|null;extendedProperties?:{private?:Record<string,string>|null}|null;
};
export type EventInput = {id?:string;summary:string;description?:string;start:{dateTime:string;timeZone:string};end:{dateTime:string;timeZone:string};
  transparency?:string;reminders?:{useDefault:boolean};extendedProperties?:{private:Record<string,string>}};
export interface CalendarGateway {
  list(from:number,to:number):Promise<DemoEvent[]>;
  busy(from:number,to:number):Promise<{start:number;end:number}[]>;
  create(event:EventInput):Promise<DemoEvent>;
  get(id:string):Promise<DemoEvent>;
  patch(id:string,etag:string,change:Partial<EventInput>):Promise<DemoEvent>;
}
