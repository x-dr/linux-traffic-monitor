import { useEffect, useRef } from 'react';
import { theme } from 'antd';
import { init, use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { TelemetryHistory } from '@traffic/contracts';
use([LineChart,GridComponent,TooltipComponent,LegendComponent,CanvasRenderer]);
export default function TelemetryChart({history,metric}:{history:TelemetryHistory;metric:string}){
  const target=useRef<HTMLDivElement>(null),{token}=theme.useToken();
  useEffect(()=>{
    const chart=init(target.current!);const identities=[...new Set(history.points.map(p=>p.object.identity))];
    const series=identities.flatMap((identity,index)=>['avg','max'].map(kind=>{
      const points=new Map(history.points.filter(p=>p.object.identity===identity).map(p=>[p.ts,p.object]));const data=[];
      for(let ts=Math.floor(history.start/history.step)*history.step;ts<history.end;ts+=history.step){const o=points.get(ts),stats=o?.values[metric];data.push([ts*1000,o&&['ok','absent'].includes(o.status)?stats?.[kind as 'avg'|'max']??null:null]);}
      return {name:`${kind==='avg'?'均值':'最大值'}${identities.length>1?` · 身份 ${index+1}`:''}`,type:'line',connectNulls:false,showSymbol:false,data,lineStyle:{width:kind==='avg'?2:1,type:kind==='avg'?'solid':'dashed'}};
    }));
    chart.setOption({animation:false,color:['#789cff','#f6bd68','#53d6b5'],legend:{top:0,textStyle:{color:token.colorTextSecondary}},grid:{left:65,right:18,top:45,bottom:30},tooltip:{trigger:'axis',confine:true,backgroundColor:token.colorBgElevated,borderColor:token.colorBorder,textStyle:{color:token.colorText}},xAxis:{type:'time',axisLabel:{color:token.colorTextSecondary,hideOverlap:true}},yAxis:{type:'value',min:0,axisLabel:{color:token.colorTextSecondary},splitLine:{lineStyle:{color:token.colorBorderSecondary,type:'dashed'}}},series});
    const observer=new ResizeObserver(()=>chart.resize());observer.observe(target.current!);return()=>{observer.disconnect();chart.dispose();};
  },[history,metric,token.colorTextSecondary,token.colorBgElevated,token.colorBorder,token.colorText,token.colorBorderSecondary]);
  return <div className="trend-chart" ref={target} role="img" aria-label={`${metric} 指标历史趋势图`} />;
}
