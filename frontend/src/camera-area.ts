import { t } from "./i18n";
export type Area = {x:number;y:number;xlen:number;ylen:number};
export function validArea(area:Area) {
  return Object.values(area).every(Number.isInteger) && area.x>=0 && area.y>=0 && area.xlen>=1 && area.ylen>=1 && area.x+area.xlen<=100 && area.y+area.ylen<=100;
}
export function parseArea(value:string):{document:Record<string,unknown>;area:Area}|null {
  try {
    const document=JSON.parse(value), region=document?.region0;
    if (!document || Array.isArray(document) || document.num!==1 || !region || typeof region!=='object' || Array.isArray(region)) return null;
    const area={x:region.x,y:region.y,xlen:region.xlen,ylen:region.ylen};
    return validArea(area) ? {document,area} : null;
  } catch {return null;}
}
export function encodeArea(document:Record<string,unknown>,area:Area) {
  if (!validArea(area)) throw new Error(t("Область должна находиться внутри изображения."));
  return JSON.stringify({...document,region0:{...(document.region0 as object),...area}});
}
export function shiftArea(area:Area,dx:number,dy:number,resize=false):Area {
  const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,Math.round(n)));
  return resize ? {...area,xlen:clamp(area.xlen+dx,1,100-area.x),ylen:clamp(area.ylen+dy,1,100-area.y)} : {...area,x:clamp(area.x+dx,0,100-area.xlen),y:clamp(area.y+dy,0,100-area.ylen)};
}
