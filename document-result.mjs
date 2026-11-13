export function validateDocumentResult(data){
 const categories=['课程资料','方法文档','学员产出','照片记录','其他资料'];
 if(!data||!categories.includes(data.category)||!Array.isArray(data.tags)||!data.tags.length||data.tags.length>8||data.tags.some(t=>typeof t!=='string'||!t.trim()||t.length>16)||typeof data.summary!=='string'||!data.summary.trim()||data.summary.length>1500){
  throw Object.assign(Error('AI 返回的分类、标签或摘要格式不符合要求，请重试'),{status:502,code:'AI_SCHEMA',expose:true});
 }
 return {category:data.category,tags:[...new Set(data.tags.map(t=>t.trim()))],summary:data.summary.trim()};
}

