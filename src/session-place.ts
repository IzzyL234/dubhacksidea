import type {Context} from './learning.ts';
export function describedPlace(text:string):Context['location']|null{
 const matches:[Context['location'],RegExp][]=[['library',/\b(library|suzzallo|suzzalo|odegaard|odegard)\b/i],['cafe',/\b(cafe|café|coffee shop|coffeehouse|starbucks)\b/i],['dorm_room',/\b(dorm|dormitory|residence hall)\b/i],['classroom',/\b(classroom|lecture hall|seminar room)\b/i],['home',/\b(home|my apartment|my house|my bedroom)\b/i]];
 const found=matches.filter(([,pattern])=>pattern.test(text)).map(([place])=>place);
 return found.length===1?found[0]!:null;
}
