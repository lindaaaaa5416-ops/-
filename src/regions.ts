import raw from 'china-division/dist/pc.json';
export const regions:Record<string,string[]>={...raw,'香港特别行政区':['香港'],'澳门特别行政区':['澳门'],'台湾省':['台北市','新北市','桃园市','台中市','台南市','高雄市','基隆市','新竹市','嘉义市','新竹县','苗栗县','彰化县','南投县','云林县','嘉义县','屏东县','宜兰县','花莲县','台东县','澎湖县','金门县','连江县'],'其他':['其他']};
regions['四川省']=[...regions['四川省'],'西昌市'];
export function normalizeCity(city:string){return city==='成都'?'成都市':city==='西昌'?'西昌市':city}
export function provinceOf(p:{city:string;province?:string}){return p.province||Object.keys(regions).find(key=>regions[key].includes(normalizeCity(p.city)))||'其他'}
export function regionMatches(p:{city:string;province?:string},province:string,city:string){return (!province||provinceOf(p)===province)&&(!city||normalizeCity(p.city)===city)}
