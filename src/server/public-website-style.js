export const websiteStyle = `
:root{--ink:#172033;--muted:#5b6780;--primary:#4f6b95;--accent:#edf2f8;--line:#dbe3ef;--paper:#ffffff;--navy:#101a2b}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:100px}
body{margin:0;color:var(--ink);background:var(--paper);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
button,input{font:inherit}
a,summary{touch-action:manipulation}
a:focus-visible,summary:focus-visible{outline:3px solid #456bae;outline-offset:5px}
svg{display:block}
p{line-height:1.85}
h1,h2,h3,p{margin:0}
ul{margin:0;padding:0;list-style:none}
.wrap{width:min(1240px,calc(100% - 96px));margin:auto}
.site-header{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.96);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
.nav-shell{height:82px;display:flex;align-items:center;gap:52px}
.brand{display:inline-flex;align-items:center;gap:11px;font-size:21px;font-weight:800;letter-spacing:-.8px;white-space:nowrap}
.brand-symbol{width:33px;height:33px;background:var(--primary);border-radius:10px;display:grid;place-items:center;color:white}
.brand em{font-style:normal;font-size:12px;font-weight:500;border:1px solid #caced4;border-radius:5px;padding:3px 5px;letter-spacing:.3px;margin-left:3px}
.main-nav{display:flex;gap:32px;font-size:14px;color:#565c66}
.main-nav a{padding:30px 0;position:relative}
.main-nav a:hover,.main-nav a[aria-current=page]{color:var(--primary)}
.main-nav a[aria-current=page]:after{content:'';height:2px;background:var(--primary);position:absolute;bottom:18px;left:0;right:0}
.nav-actions{margin-left:auto;display:flex;gap:24px;align-items:center;font-size:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:22px;min-height:48px;padding:0 23px;background:var(--primary);color:white;border:1px solid transparent;border-radius:7px;font-size:14px;font-weight:600;transition:background .2s,transform .2s}
.btn:hover{background:#3d567c;transform:translateY(-2px)}
.btn.small{min-height:40px;padding:0 18px;font-size:13px}
.btn.bright{background:var(--primary);color:white}
.btn.bright:hover{background:#3d567c}
.btn.outline{background:transparent;border-color:#c8ccd2;color:var(--ink)}
.btn.outline:hover{background:#e5e9f0}
.btn .arrow{font-size:20px;font-weight:400}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:2px;color:var(--primary);display:flex;align-items:center;gap:12px;margin-bottom:23px}
.eyebrow:before{content:'';width:24px;height:1px;background:currentColor}
.hero-zone{background:linear-gradient(120deg,#fff 12%,#f5f8fc 100%);color:var(--ink);position:relative;overflow:hidden}
.hero-zone:after{content:'';position:absolute;width:600px;height:600px;border:1px solid #4f6b9507;border-radius:50%;right:-260px;top:-100px;box-shadow:0 0 0 80px #4f6b9503,0 0 0 160px #4f6b9502;pointer-events:none}
.hero{min-height:654px;display:grid;grid-template-columns:1fr 1.12fr;align-items:center;gap:70px;padding-top:72px;padding-bottom:76px;position:relative;z-index:1}
.hero .eyebrow{color:var(--primary);font-size:11px}
.hero h1{font-size:clamp(40px,4.1vw,58px);font-weight:600;line-height:1.23;letter-spacing:-2.5px}
.hero h1 span{color:var(--primary)}
.hero-copy>p{font-size:15px;color:var(--muted);max-width:410px;margin:27px 0 32px}
.hero-actions{display:flex;gap:13px}
.hero-actions .outline{color:var(--ink);border-color:#c6d1e1;background:white}
.hero-actions .outline:hover{background:#edf2f8}
.hero-note{font-size:11px;color:#6d7c93;margin-top:22px;display:flex;gap:18px}
.hero-note span:before{content:'✓';color:var(--primary);margin-right:6px}
.product-frame{display:block;border:1px solid #c6d1e1;box-shadow:0 24px 55px #17203312;border-radius:10px;overflow:hidden;background:#f8fafc}
.hero-product{margin:0;min-width:0}
.product-screenshot{display:block;width:100%;height:auto}
.dashboard-caption{font-size:10px;color:#7a889e;margin-top:16px;text-align:right;letter-spacing:1px}
.hero-proof{border-top:1px solid var(--line);display:flex;justify-content:space-between;padding:24px 0;color:var(--muted);font-size:12px;position:relative;z-index:1}
.hero-proof strong{font-weight:500;color:var(--ink);margin-right:10px}
.hero-proof .proof-label{color:#77859b;font-size:10px;letter-spacing:1.3px}
.section{padding:100px 0}
.section-heading{display:flex;align-items:end;justify-content:space-between;gap:40px;margin-bottom:40px}
.section h2,.section-heading h2{font-size:36px;font-weight:600;line-height:1.4;letter-spacing:-1.2px}
.section-heading>p{max-width:320px;font-size:14px;color:var(--muted);line-height:1.85}
.features-grid{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:18px}
.feature-card{border:1px solid var(--line);border-radius:12px;padding:30px;background:white;min-height:290px;display:flex;flex-direction:column;overflow:hidden;position:relative}
.feature-card:first-child{background:#dfe5ef;border-color:#d1d8e3}
.feature-number{font-size:10px;color:#848c9a;letter-spacing:1px;margin-bottom:31px}
.feature-card h3{font-size:21px;font-weight:600;margin-bottom:12px}
.feature-card p{font-size:13px;color:#6e7581;max-width:280px}
.feature-card .feature-bottom{margin-top:auto;padding-top:25px;display:flex;gap:8px;flex-wrap:wrap}
.chip{font-size:10px;padding:6px 9px;border:1px solid #d5dae3;border-radius:4px;color:#535e72;background:#ffffff70}
.workflow-section{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#f8fafc}
.workflow{display:grid;grid-template-columns:.8fr 1.2fr;gap:90px;align-items:center}
.workflow-copy>p{margin-top:22px;font-size:14px;color:var(--muted);max-width:350px}
.workflow-link{display:inline-flex;gap:20px;font-size:13px;font-weight:600;margin-top:30px;color:var(--primary)}
.steps{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.step{padding:24px;border:1px solid var(--line);border-radius:8px}
.step>span{font-family:monospace;color:#8792a6;font-size:12px}
.step h3{font-size:16px;font-weight:600;margin:17px 0 8px}
.step p{font-size:12px;color:var(--muted)}
.mini-plans{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.mini-plan{border:1px solid var(--line);padding:30px;border-radius:10px;background:white}
.mini-plan.featured{border-color:#97aaca;background:#e4e9f2}
.mini-plan h3{font-size:17px;font-weight:500}
.mini-plan .mini-price{font-size:35px;letter-spacing:-1px;font-weight:600;margin:22px 0 8px}
.mini-price small{font-size:12px;font-weight:400;color:#6c7686;letter-spacing:0}
.mini-plan>p{font-size:12px;color:var(--muted)}
.mini-plan a{margin-top:25px;display:inline-flex;font-size:13px;gap:18px;color:var(--primary);font-weight:600}
.bottom-cta{background:var(--navy);color:white;border-radius:14px;padding:54px 60px;display:flex;align-items:center;justify-content:space-between;gap:30px;margin-bottom:84px;position:relative;overflow:hidden}
.bottom-cta h2{font-size:29px;font-weight:500;line-height:1.5;letter-spacing:-.5px}
.bottom-cta .btn.bright{background:#e8eef8;color:#172033}
.bottom-cta .btn.bright:hover{background:white}
.bottom-cta p{color:#a7b3c7;font-size:13px;margin-top:10px}
.site-footer{border-top:1px solid var(--line);padding:46px 0 25px}
.footer-top{display:flex;justify-content:space-between;gap:32px;margin-bottom:40px}
.footer-top p{font-size:12px;color:var(--muted);margin-top:13px}
.footer-links{display:flex;gap:36px;font-size:12px;color:#5f6774;align-items:flex-start;padding-top:5px}
.footer-bottom{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding-top:20px;font-size:10px;color:#7f8794;line-height:1.8}
.page-intro{text-align:center;padding:72px 20px 42px}
.page-intro .eyebrow{justify-content:center}
.page-intro h1{font-size:43px;line-height:1.4;letter-spacing:-1.8px;font-weight:600}
.page-intro>p{font-size:14px;color:var(--muted);margin:18px auto 0;max-width:600px}
.pricing-note{display:flex;align-items:center;justify-content:center;gap:25px;font-size:11px;color:#707a8b;margin:27px 0 0}
.pricing-note span:before{content:'✓';color:var(--primary);margin-right:6px}
.pricing-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;padding-top:22px}
.plan-card{border:1px solid var(--line);padding:29px 24px 24px;background:white;border-radius:10px;position:relative;display:flex;flex-direction:column}
.plan-card.recommended{border:1px solid #506c9b;box-shadow:0 5px 22px #26375508;background:#e9eef6}
.plan-ribbon{position:absolute;top:-13px;left:22px;background:var(--primary);color:#dfe7f6;font-size:10px;padding:5px 10px;border-radius:4px}
.plan-kind{font-size:9px;color:#7b879c;letter-spacing:1.5px;margin-bottom:12px}
.plan-card h2{font-size:18px;font-weight:600}
.plan-description{font-size:11px;color:#788190;margin-top:9px;min-height:35px;line-height:1.7}
.plan-price{margin:23px 0 21px;white-space:nowrap}
.plan-price strong{font-size:37px;letter-spacing:-1.8px;font-weight:600}
.plan-price span{font-size:11px;color:#788190;margin-left:5px}
.plan-card .btn{width:100%;min-height:43px;font-size:12px}
.plan-capacity{font-size:12px;font-weight:600;padding:23px 0 17px;border-bottom:1px solid var(--line);margin-bottom:19px}
.plan-features{display:grid;gap:13px;font-size:11px;color:#576171}
.plan-features li{display:flex;gap:9px;align-items:baseline;line-height:1.6}
.plan-features li:before{content:'✓';color:#4b6592}
.plan-features li.unavailable{color:#838891}
.plan-features li.unavailable:before{content:'−';color:#a6aab1}
.trial-row{margin:29px 0 16px;border:1px solid var(--line);border-radius:9px;background:#e9ecf1;padding:22px 26px;display:flex;align-items:center;gap:30px}
.trial-intro{flex:1}
.trial-intro h2{font-size:15px;margin-bottom:6px}
.trial-intro p{font-size:11px;color:var(--muted)}
.trial-option{display:flex;gap:20px;align-items:center;border-left:1px solid #ced4de;padding-left:27px}
.trial-option strong{font-size:23px;font-weight:600}
.trial-option strong small{font-size:12px;font-weight:400}
.trial-option p{font-size:10px;color:var(--muted)}
.trial-option a{font-size:11px;color:var(--primary);white-space:nowrap}
.price-disclaimer{font-size:11px;color:#788190;line-height:1.9;margin:13px 0 65px}
.faq{padding:0 0 80px;display:grid;grid-template-columns:1fr 2fr;gap:70px}
.faq h2{font-size:25px;font-weight:500}
.faq details{border-bottom:1px solid var(--line);padding:22px 0}
.faq details:first-child{padding-top:3px}
.faq summary{font-size:14px;cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:15px}
.faq summary:after{content:'+';color:#6c7a91}
.faq details[open] summary:after{content:'−'}
.faq details p{font-size:12px;color:var(--muted);padding-top:14px;max-width:600px}
.docs-banner{border-bottom:1px solid var(--line);background:#f8fafc;padding:47px 0}
.docs-banner .eyebrow{margin-bottom:13px}
.docs-banner h1{font-size:34px;font-weight:600;letter-spacing:-1px}
.docs-banner p{font-size:13px;color:var(--muted);margin-top:12px}
.docs-layout{display:grid;grid-template-columns:225px 1fr;gap:75px;padding-top:46px;padding-bottom:90px}
.docs-sidebar{position:sticky;top:116px;align-self:start;display:grid;gap:7px}
.docs-sidebar>span{font-size:10px;letter-spacing:1.2px;color:#8f97a4;padding:0 13px 10px}
.docs-sidebar a{padding:11px 13px;border-radius:5px;font-size:12px;color:#656f80}
.docs-sidebar a:hover{background:#e1e6f0;color:var(--primary)}
.docs-sidebar .start{background:#dde4ef;color:var(--primary)}
.docs-content{max-width:770px}
.doc-section{padding:0 0 36px;margin-bottom:36px;border-bottom:1px solid var(--line)}
.doc-section:last-child{border:0;margin:0}
.doc-label{font-size:10px;color:#7c8aa2;letter-spacing:1px;margin-bottom:12px}
.doc-section h2{font-size:24px;font-weight:600;margin-bottom:20px;letter-spacing:-.5px}
.doc-section p{font-size:13px;color:#626a77;margin:12px 0}
.doc-section ol{padding-left:21px;color:#626a77;font-size:13px;line-height:2.3}
.doc-callout{padding:16px 20px;background:#e1e6f0;border-left:3px solid #617aa4;border-radius:0 6px 6px 0;font-size:12px;color:#45546e;line-height:1.9;margin-top:21px}
.doc-section .inline-link{color:var(--primary);text-decoration:underline;text-underline-offset:3px}
.doc-credit-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}
.doc-credit-grid>div{padding:20px 15px;background:white;border:1px solid var(--line);border-radius:7px}
.doc-credit-grid strong{display:block;font-size:24px;font-weight:500;margin-bottom:9px}
.doc-credit-grid span{font-size:11px;color:var(--muted)}

@media(min-width:1600px){.hero{min-height:700px}
.hero h1{font-size:62px}
}
@media(max-width:1100px){.wrap{width:calc(100% - 56px)}
.nav-shell{gap:30px}
.main-nav{gap:22px}
.hero{gap:30px;grid-template-columns:1fr 1fr}
.hero h1{font-size:45px}
.pricing-grid{gap:10px}
.plan-card{padding:25px 17px}
.plan-price strong{font-size:31px}
.workflow{gap:45px}
.section h2{font-size:31px}
.docs-layout{gap:40px}
}
@media(max-width:800px){.wrap{width:calc(100% - 40px)}
.nav-shell{height:70px;gap:25px}
.brand{font-size:18px}
.brand em{display:none}
.main-nav{gap:20px;font-size:12px}
.nav-actions{gap:13px;font-size:12px}
.nav-actions .btn{min-height:36px;padding:0 12px;font-size:11px}
.hero{grid-template-columns:1fr;padding:65px 0 40px;gap:40px;min-height:0}
.hero-copy{text-align:center}
.hero .eyebrow{justify-content:center}
.hero h1{font-size:49px}
.hero-copy>p{margin:23px auto 28px;max-width:440px}
.hero-actions,.hero-note{justify-content:center}
.hero-product{max-width:670px;width:100%;margin:auto}
.product-frame{display:block;border:1px solid #c6d1e1;box-shadow:0 24px 55px #17203312;border-radius:10px;overflow:hidden;background:#f8fafc}
.dashboard-caption{text-align:center}
.hero-proof{gap:15px;flex-wrap:wrap;font-size:10px}
.hero-proof .proof-label{width:100%;margin-bottom:4px}
.section{padding:65px 0}
.section-heading{gap:25px;align-items:start}
.section h2{font-size:29px}
.section-heading>p{max-width:230px;font-size:12px}
.features-grid{grid-template-columns:1fr 1fr}
.feature-card:first-child{grid-column:1/-1;min-height:250px}
.feature-card{min-height:260px;padding:25px}
.workflow{grid-template-columns:1fr;gap:30px}
.workflow-copy>p{max-width:520px}
.mini-plans{gap:12px}
.mini-plan{padding:22px 18px}
.mini-plan .mini-price{font-size:27px}
.bottom-cta{padding:35px;gap:25px;margin-bottom:60px}
.bottom-cta h2{font-size:24px}
.pricing-grid{grid-template-columns:repeat(2,1fr);gap:25px 16px}
.plan-card{padding:28px}
.plan-price strong{font-size:38px}
.trial-row{align-items:start;flex-wrap:wrap;gap:22px}
.trial-intro{flex-basis:100%}
.trial-option{padding:0;border:0;flex:1;gap:15px}
.faq{gap:30px;grid-template-columns:1fr 2fr}
.docs-layout{grid-template-columns:170px 1fr;gap:25px}
.doc-credit-grid{gap:8px}
.doc-credit-grid>div{padding:17px 10px}
.doc-credit-grid strong{font-size:21px}
.footer-links{gap:22px}
}
@media(max-width:560px){.wrap{width:calc(100% - 36px)}
.nav-shell{gap:13px;flex-wrap:wrap;height:auto;padding:15px 0 0}
.brand{font-size:17px;gap:8px}
.brand-symbol{width:28px;height:28px;border-radius:8px}
.nav-actions{gap:14px}
.nav-actions .btn{min-height:32px;padding:0 11px}
.main-nav{order:3;width:100%;justify-content:space-between;padding:0 4px}
.main-nav a{padding:18px 0 16px}
.main-nav a[aria-current=page]:after{bottom:5px}
.hero{padding-top:45px;gap:35px}
.hero h1{font-size:39px;letter-spacing:-1.5px}
.hero .eyebrow{font-size:9px;letter-spacing:1px;margin-bottom:19px}
.hero-copy>p{font-size:13px;max-width:310px;margin:23px auto 25px}
.hero-actions .btn{min-height:45px;padding:0 18px;font-size:12px;gap:15px}
.hero-note{font-size:9px;gap:12px}
.hero-proof{justify-content:space-between;gap:17px 6px;font-size:9px;padding:22px 0}
.hero-proof strong{display:block;margin:0 0 5px;font-size:11px}
.section{padding:53px 0}
.section-heading{display:block;margin-bottom:27px}
.section-heading>p{max-width:100%;margin-top:18px}
.section .eyebrow{margin-bottom:16px}
.section h2{font-size:28px;letter-spacing:-1px}
.features-grid{grid-template-columns:1fr;gap:12px}
.feature-card:first-child{grid-column:auto}
.feature-card{padding:25px;min-height:238px}
.feature-number{margin-bottom:24px}
.feature-card h3{font-size:20px}
.steps{gap:10px}
.step{padding:20px 17px}
.step h3{font-size:14px}
.step p{font-size:11px}
.mini-plans{grid-template-columns:1fr;gap:12px}
.mini-plan{display:grid;grid-template-columns:1fr auto;gap:0 10px;padding:23px}
.mini-plan .mini-price{grid-column:2;grid-row:1/3;margin:0;font-size:27px;align-self:center}
.mini-plan>p{margin-top:10px;font-size:11px}
.mini-plan a{margin-top:20px;font-size:11px}
.bottom-cta{padding:30px 24px;display:block;margin-bottom:45px;border-radius:10px}
.bottom-cta h2{font-size:24px}
.bottom-cta .btn{margin-top:25px}
.footer-top{display:block;margin-bottom:29px}
.footer-links{margin-top:24px;gap:25px}
.footer-bottom{display:block;font-size:9px}
.footer-bottom span{display:block;margin-bottom:7px}
.site-footer{padding-top:30px}
.page-intro{padding:45px 0 32px}
.page-intro h1{font-size:32px;letter-spacing:-1.2px}
.page-intro>p{font-size:12px;max-width:320px}
.pricing-note{gap:10px;flex-wrap:wrap;font-size:9px;margin-top:20px}
.pricing-grid{grid-template-columns:1fr;gap:24px}
.plan-card{padding:26px}
.plan-price{margin:15px 0 20px}
.plan-price strong{font-size:38px}
.plan-description{min-height:0;font-size:12px}
.plan-features{grid-template-columns:1fr 1fr;gap:12px 8px;font-size:10px}
.plan-capacity{padding:20px 0 16px}
.trial-row{padding:24px;display:block;margin-top:22px}
.trial-option{margin-top:23px;justify-content:space-between}
.trial-intro p{font-size:10px}
.price-disclaimer{margin-bottom:45px;font-size:10px}
.faq{grid-template-columns:1fr;gap:25px;padding-bottom:45px}
.faq details{padding:20px 0}
.docs-banner{padding:32px 0}
.docs-banner h1{font-size:29px}
.docs-banner p{font-size:12px}
.docs-layout{display:block;padding-top:24px;padding-bottom:40px}
.docs-sidebar{position:static;display:flex;flex-wrap:wrap;gap:7px;border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:30px}
.docs-sidebar>span{display:none}
.docs-sidebar a{padding:8px 10px;font-size:11px;background:#e6eaf1}
.doc-section h2{font-size:21px}
.doc-section p,.doc-section ol{font-size:12px}
.doc-credit-grid strong{font-size:19px}
.doc-credit-grid span{font-size:9px}
.doc-callout{font-size:11px;padding:14px 16px}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}
*{transition:none!important}
}

`;
