const ChromeRender = require('chrome-render');
const { JSDOM } = require('jsdom');

ChromeRender.new().then(async(chromeRender)=>{
    const htmlString = await chromeRender.render({
        url: 'http://www.google.com',
    });
    const dom = new JSDOM(htmlString);
    const text = dom.window.document.getElementById('hplogo').querySelector('div[class="logo-subtext"]').textContent;
    console.log(text);
});
