"""Builds assets/default-template.pptx: Canopus's built-in presentation template (16:9, navy/orange theme).

It starts from python-pptx's plain Office template (layouts, master, theme) and restyles it. Run it only when the
default template should change; the generated file is committed:  python3 scripts/make-default-template.py
"""
import os, re, zipfile, pptx

SRC = os.path.join(os.path.dirname(pptx.__file__), 'templates', 'default.pptx')
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'default-template.pptx')
W = 12192000 / 9144000  # 4:3 → 16:9 (height unchanged)

def widen(x):
    x = re.sub(r'(<a:off x=")(\d+)', lambda m: m.group(1) + str(round(int(m.group(2)) * W)), x)
    return re.sub(r'(<a:ext cx=")(\d+)', lambda m: m.group(1) + str(round(int(m.group(2)) * W)), x)

def rect(id_, name, x, y, cx, cy, clr):
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{id_}" name="{name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr>'
            f'<a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
            f'<a:solidFill><a:schemeClr val="{clr}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>'
            f'<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="id-ID"/></a:p></p:txBody></p:sp>')

NAVY_BG = '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
GRP = '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

def fix(name, x):
    if name == 'ppt/presentation.xml':
        return re.sub(r'<p:sldSz[^>]*/>', '<p:sldSz cx="12192000" cy="6858000"/>', x)
    if name == 'ppt/theme/theme1.xml':
        colors = dict(dk2='1F3A5F', lt2='EEF2F7', accent1='1E5AA8', accent2='E8772E', accent3='2E9E6B', accent4='C2413A', accent5='7A5BB5', accent6='2AA5B8')
        for k, v in colors.items():
            x = re.sub(rf'(<a:{k}>)<a:srgbClr val="[0-9A-F]+"/>', rf'\1<a:srgbClr val="{v}"/>', x)
        return x.replace('<a:clrScheme name="Office">', '<a:clrScheme name="Canopus">')
    if name == 'ppt/slideMasters/slideMaster1.xml':
        x = widen(x)
        # Title top-left, navy and bold; body text sized for reports.
        x = x.replace('<a:off x="609600" y="274638"/><a:ext cx="10972800" cy="1143000"/>', '<a:off x="609600" y="330000"/><a:ext cx="10972800" cy="900000"/>')
        x = x.replace('<a:off x="609600" y="1600200"/><a:ext cx="10972800" cy="4525963"/>', '<a:off x="609600" y="1420000"/><a:ext cx="10972800" cy="4800000"/>')
        x = x.replace('<p:titleStyle><a:lvl1pPr algn="ctr"', '<p:titleStyle><a:lvl1pPr algn="l"')
        x = re.sub(r'(<p:titleStyle>.*?)<a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/>',
                   r'\1<a:defRPr sz="3000" b="1" kern="1200"><a:solidFill><a:schemeClr val="tx2"/>', x, flags=re.S)
        body = x[x.find('<p:bodyStyle>'):x.find('</p:bodyStyle>')]
        sizes = {1: '2000', 2: '1800', 3: '1600', 4: '1400', 5: '1400'}
        nb = re.sub(r'(<a:lvl(\d)pPr[^>]*>.*?<a:defRPr sz=")(\d+)', lambda m: m.group(1) + sizes.get(int(m.group(2)), m.group(3)), body, flags=re.S)
        x = x.replace(body, nb)
        deco = rect(90, 'Accent bar', 0, 470000, 190000, 620000, 'accent2') + rect(91, 'Bottom line', 0, 6790000, 12192000, 68000, 'tx2')
        return x.replace(GRP, GRP + deco, 1)
    if name.startswith('ppt/slideLayouts/slideLayout') and name.endswith('.xml'):
        x = widen(x)
        n = int(re.search(r'(\d+)\.xml$', name).group(1))
        if n in (1, 3):
            x = x.replace('preserve="1"', 'preserve="1" showMasterSp="0"', 1)
            x = re.sub(r'(<p:cSld name="[^"]*">)', r'\1' + NAVY_BG, x, count=1)
            x = x.replace('<a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr>', '<a:schemeClr val="bg1"><a:lumMod val="85000"/></a:schemeClr>')
        if n == 1:
            x = x.replace('<a:off x="914400" y="2130425"/><a:ext cx="10363200" cy="1470025"/>', '<a:off x="914400" y="2050000"/><a:ext cx="10363200" cy="1500000"/>')
            x = x.replace('<a:off x="1828800" y="3886200"/><a:ext cx="8534400" cy="1752600"/>', '<a:off x="914400" y="3850000"/><a:ext cx="10363200" cy="1300000"/>')
            x = x.replace('<p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr>', '<p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr>', 1)
            x = re.sub(r'(<p:ph type="ctrTitle"/>.*?<p:txBody><a:bodyPr)/>(<a:lstStyle)/>',
                       r'\1 anchor="b"/>\2><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>', x, count=1, flags=re.S)
            x = x.replace('algn="ctr"', 'algn="l"')
            x = x.replace(GRP, GRP + rect(90, 'Accent bar', 914400, 3650000, 1100000, 70000, 'accent2'), 1)
        if n == 3:
            x = x.replace('<a:defRPr sz="4000" b="1" cap="all"/>', '<a:defRPr sz="3600" b="1"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:defRPr>')
            x = x.replace(GRP, GRP + rect(90, 'Accent bar', 963084, 4250000, 1100000, 70000, 'accent2'), 1)
        return x
    return x

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with zipfile.ZipFile(SRC) as src, zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as out:
    for item in src.infolist():
        if item.filename == 'docProps/thumbnail.jpeg' or item.filename.startswith('ppt/printerSettings'):
            continue
        data = src.read(item.filename)
        if item.filename.endswith('.xml') or item.filename.endswith('.rels'):
            t = data.decode('utf-8')
            t = fix(item.filename, t)
            if item.filename == '[Content_Types].xml':
                t = re.sub(r'<Default Extension="jpeg"[^>]*/>', '', t)
                t = re.sub(r'<Default Extension="bin"[^>]*/>', '', t)
                t = re.sub(r'<Override PartName="/ppt/printerSettings[^>]*/>', '', t)
            if item.filename == '_rels/.rels':
                t = re.sub(r'<Relationship[^>]*thumbnail[^>]*/>', '', t)
            if item.filename == 'ppt/_rels/presentation.xml.rels':
                t = re.sub(r'<Relationship[^>]*printerSettings[^>]*/>', '', t)
            data = t.encode('utf-8')
        out.writestr(item.filename, data)
print('wrote', os.path.normpath(OUT))
