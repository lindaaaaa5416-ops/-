export const DIMENSIONS=[
 {key:'环节',question:'什么时候用'},
 {key:'学科',question:'讲什么'},
 {key:'形态',question:'是什么东西'},
 {key:'人群',question:'给谁用'},
 {key:'复用',question:'怎么再用上'},
];
export const PREFIXES=DIMENSIONS.map(d=>d.key);

export const VOCAB={
 环节:['课前准备','课上讲授','课后复盘','招生沟通'],
 学科:['时间管理','沟通表达','团队协作','情绪管理'],
 形态:['PPT模板','讲义','练习题库','活动流程表','话术脚本','照片记录','测评问卷'],
 人群:['新教师','企业新员工','公益学员','亲子家庭'],
 复用:['可直接套用','需改编','案例参考','数据基线'],
};
