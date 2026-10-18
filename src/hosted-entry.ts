import {hostedWeb} from './hosted-web.ts';
export default {fetch:(request:Request)=>hostedWeb(request)};
