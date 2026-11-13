import residency from './assets/product-badges/residency.svg';
import friendship from './assets/product-badges/friendship.svg';
import friendship2 from './assets/product-badges/friendship-2.svg';
import ra from '../../src/components/subscription-storefront/assets/plan-art/ра.svg';

const badges: Record<string, { src: string; width: number; height: number }> = {
  residency: { src: residency, width: 391, height: 55 },
  friendship: { src: friendship, width: 826, height: 128 },
  'friendship-2': { src: friendship2, width: 1033, height: 128 },
  ra: { src: ra, width: 72, height: 22 },
};

export function ProductBadge({ product, name }: { product: string; name: string }) {
  const badge = Object.hasOwn(badges, product) ? badges[product] : undefined;
  return badge ? <img className="matrix-product-badge" src={badge.src} alt={name} width={badge.width} height={badge.height} /> : <>{name}</>;
}
