"""Independent reference checks and a reproducible CSV report for the live benchmark.

Uses explicitly recorded Wikidata image/category relationships and Commons license
metadata. 'Unconfirmed' never means that no photo exists anywhere on the web.
"""
import argparse
import csv
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote

import place_photos as photos
from benchmark_place_photos import inputs


def is_photo(result):
    photo = result.get('photo')
    return bool(photo and not re.search(r'\b(?:map|maps|logo|diagram|painting|drawing)\b|地形図|位置図|案内図|配置図|ロゴ', photo['title'], re.I))


def title(value):
    return unquote(value.split('/wiki/')[-1]).removeprefix('File:').replace('_', ' ')


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--after-stage', default='after-final')
    args = parser.parse_args()
    root = Path(__file__).parent
    cases = inputs(root)
    records = {stage: {} for stage in ('before', 'after')}
    for stage in records:
        prefix = args.after_stage if stage == 'after' else 'before'
        for f in args.work.glob(prefix+'-*.json'):
            data = json.loads(f.read_text(encoding='utf-8'))
            if 'case' in data: records[stage][data['case']['id']] = data
    if any(len(records[s]) != len(cases) for s in records): raise SystemExit('Complete both benchmark stages first')
    saved = args.work/'reference-v2.json'
    references = json.loads(saved.read_text(encoding='utf-8')) if saved.exists() else {}
    entities = {}
    for stage in records.values():
        for rec in stage.values():
            for call in rec['trace']:
                entities.update(call.get('data', {}).get('entities', {}))
    missing = sorted({c['qid'] for c in cases if c['qid'] and c['qid'] not in entities})
    for offset in range(0, len(missing), 15):
        resolver = photos.Resolver(photos.validate_place(cases[0]['place']))
        try:
            entities.update(resolver.api('wikidata', action='wbgetentities', ids='|'.join(missing[offset:offset+15]), props='claims|sitelinks|labels', languages='ja|en').get('entities', {}))
        finally: resolver.session.close()
    for index, case in enumerate(cases):
        key = case['id']
        if key in references: continue
        ref = {'existence': 'unconfirmed', 'source': '', 'usableTitles': [], 'observedTitles': []}
        for stage in records:
            result = records[stage][key]['result']
            if is_photo(result):
                ref['existence'] = 'confirmed_reusable'
                ref['usableTitles'].append(title(result['photo']['sourceUrl']))
                ref['source'] = result['photo']['sourceUrl']
        entity = entities.get(case['qid'], {})
        claims = entity.get('claims', {})
        def values(prop): return [c.get('mainsnak', {}).get('datavalue', {}).get('value') for c in claims.get(prop, []) if c.get('rank') != 'deprecated']
        image_titles = [photos.file_title(v) for v in values('P18') if photos.file_title(v)]
        categories = [s for s in values('P373') if isinstance(s, str)]
        common = entity.get('sitelinks', {}).get('commonswiki', {}).get('title', '')
        if common.startswith('Category:'): categories.append(common[9:])
        resolver = photos.Resolver(photos.validate_place(case['place']))
        try:
            pages = []
            if image_titles:
                pages += resolver.api('commons', action='query', titles='|'.join(image_titles[:3]), prop='imageinfo', iiprop='url|mime|extmetadata', iiurlwidth=320,
                    iiextmetadatafilter='Artist|Credit|Attribution|LicenseUrl|Copyrighted|Restrictions').get('query', {}).get('pages', [])
            if not pages and categories:
                pages += resolver.api('commons', action='query', generator='categorymembers', gcmtitle='Category:'+categories[0], gcmtype='file', gcmnamespace=6, gcmlimit=5,
                    prop='imageinfo', iiprop='url|mime|extmetadata', iiurlwidth=320,
                    iiextmetadatafilter='Artist|Credit|Attribution|LicenseUrl|Copyrighted|Restrictions').get('query', {}).get('pages', [])
            for p in pages:
                if p.get('imageinfo'):
                    ref['observedTitles'].append(p['title'])
                    if ref['existence'] == 'unconfirmed': ref['existence'] = 'confirmed_photo_rights_unconfirmed'
                if photos.photo_from_page(p):
                    ref['existence'] = 'confirmed_reusable'
                    ref['usableTitles'].append(title(p['title']))
                    ref['source'] = 'https://www.wikidata.org/wiki/'+str(case['qid'])
        except photos.PhotoError as error:
            ref['auditError'] = error.code
        finally: resolver.session.close()
        ref['usableTitles'] = sorted(set(ref['usableTitles']))
        references[key] = ref
        saved.write_text(json.dumps(references, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'audit': index+1, 'total':len(cases), 'id':key, 'existence':ref['existence']}), flush=True)
    rows = []
    for case in cases:
        key = case['id']; a,b = (records[s][key]['result'] for s in ('before','after')); ref=references[key]
        rows.append({'id':key,'name':case['place']['name'],'category':case['category'],'provider':case['provider'],
                     'before':a['status'],'after':b['status'],'before_photo_valid':is_photo(a),'after_photo_valid':is_photo(b),
                     'before_wrong_kind':bool(a.get('photo')) and not is_photo(a),'after_wrong_kind':bool(b.get('photo')) and not is_photo(b),
                     'before_seconds':a['seconds'],'after_seconds':b['seconds'],
                     'existence':ref['existence'],'before_missed':ref['existence']=='confirmed_reusable' and a['status']!='found',
                     'after_missed':ref['existence']=='confirmed_reusable' and b['status']!='found',
                     'before_source':(a['photo'] or {}).get('sourceUrl',''),'after_source':(b['photo'] or {}).get('sourceUrl',''),
                     'after_confidence':(b['photo'] or {}).get('match',{}).get('level',''),
                     'reference':ref['source'],'audit_error':ref.get('auditError','')})
    args.output.mkdir(parents=True,exist_ok=True)
    with (args.output/'photo-results.csv').open('w',encoding='utf-8',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    summary={'count':len(rows),'baselineSha256':hashlib.sha256(args.baseline.read_bytes()).hexdigest(),'knownReusable':sum(r['existence']=='confirmed_reusable' for r in rows),
             'photoRightsUnconfirmed':sum(r['existence']=='confirmed_photo_rights_unconfirmed' for r in rows),
             'existenceUnconfirmed':sum(r['existence']=='unconfirmed' for r in rows),
             'beforeMissed':sum(r['before_missed'] for r in rows),'afterMissed':sum(r['after_missed'] for r in rows)}
    (args.work/'reference-summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps(summary),flush=True)


if __name__=='__main__':main()
