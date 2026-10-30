import { Breadcrumb } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link, useMatch } from 'react-router-dom';
import { client } from './api';

export default function WorkspaceBreadcrumb({ pageLabel, enabled = true }: { pageLabel: string; enabled?: boolean }) {
  const nodeId = useMatch('/nodes/:id')?.params.id;
  const node = useQuery({
    queryKey: ['node', nodeId],
    queryFn: () => client.node(nodeId!),
    enabled: enabled && Boolean(nodeId),
  });
  const items = [
    { title: '个人工作区', href: '/overview' },
    ...(nodeId
      ? [{ title: 'VPS 管理', href: '/nodes' }, { title: node.data?.name || '服务器详情' }]
      : [{ title: pageLabel }]),
  ];

  return <Breadcrumb
    aria-label="面包屑导航"
    className="workspace-breadcrumb"
    classNames={{ item: 'workspace-crumb', separator: 'workspace-crumb-separator' }}
    items={items}
    itemRender={item => item.href
      ? <Link className="breadcrumb-link" to={item.href}>{item.title}</Link>
      : <span className="breadcrumb-current" aria-current="page" title={String(item.title)}>{item.title}</span>}
  />;
}
