import {defineConfig} from 'vite';
export default defineConfig({server:{proxy:{'/calendar/feed.ics':{target:'http://127.0.0.1:3001',changeOrigin:false},'/api':{target:'http://127.0.0.1:3001',changeOrigin:false}}}});
