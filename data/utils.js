function isInside(pos, rect){
    return pos.x >= rect.x1 && pos.x <= rect.x2  &&  pos.y >= rect.y1 && pos.y <= rect.y2;
}

//http://www.jeffreythompson.org/collision-detection/circle-rect.php
function circleRect(bird, rectV) {
    // temporary variables to set edges for testing
    let testX = bird.pos.x;
    let testY = bird.pos.y;
  
    // which edge is closest?
    if (bird.pos.x < rectV.x1)       testX = rectV.x1;      // test left edge
    else if (bird.pos.x > rectV.x2)  testX = rectV.x2;   // right edge
    if (bird.pos.y < rectV.y1)       testY = rectV.y1;      // top edge
    else if (bird.pos.y > rectV.y2)  testY = rectV.y2;   // bottom edge
  
    // get distance from closest edges
    let distX = bird.pos.x - testX;
    let distY = bird.pos.y - testY;
    let distance = sqrt((distX*distX) + (distY*distY));
    // if the distance is less than the bird.radius, collision!
    if(DEBUG_MODE){
        pop();
            fill(0);
            rect(rectV.x1,rectV.y1,rectV.x2-rectV.x1,abs(rectV.y1-rectV.y2));
            ellipse(bird.pos.x, bird.pos.y, bird.radius-10, bird.radius-10);
        push();
    }
    if (distance <= bird.radius-10)
        return true;
    return false;
}